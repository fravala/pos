"""
Inteligencia de negocio semanal:
1. K-Means sobre revenue/margin por producto -> Matriz ABC de rentabilidad.
2. Apriori sobre canastas de la semana -> cross_selling_combos.
Guarda resultado en weekly_sales_analytics (una fila por location/week_start).
"""
import json
import logging
from datetime import date, timedelta
import pandas as pd
from sklearn.cluster import KMeans
from mlxtend.frequent_patterns import apriori, association_rules
from mlxtend.preprocessing import TransactionEncoder
from db import fetch_df, execute

logger = logging.getLogger("analytics")


def _compute_abc_matrix(location_id: str, week_start: date, week_end: date) -> list[dict]:
    sales = fetch_df(
        """
        select p.id as product_id, p.name as product_name,
               sum(oi.quantity * oi.unit_price) as revenue,
               sum(oi.quantity * oi.unit_price) - coalesce(sum(oi.quantity * vc.total_cost), 0) as margin
        from order_items oi
        join orders o on o.id = oi.order_id
        join products p on p.id = oi.product_id
        left join view_product_costs vc on vc.product_id = p.id
        where o.location_id = %s and o.created_at >= %s and o.created_at < %s and o.status = 'PAID'
        group by p.id, p.name
        """,
        (location_id, week_start, week_end),
    )

    if sales.empty:
        return []

    features = sales[["revenue", "margin"]].fillna(0)
    n_clusters = min(3, len(sales))
    kmeans = KMeans(n_clusters=n_clusters, n_init=10, random_state=42)
    sales["cluster"] = kmeans.fit_predict(features)

    # Ordena clusters por revenue promedio descendente -> A (mejor), B, C (peor)
    cluster_rank = (
        sales.groupby("cluster")["revenue"].mean().sort_values(ascending=False).index.tolist()
    )
    label_map = {cluster_rank[i]: label for i, label in enumerate(["A", "B", "C"][:n_clusters])}
    sales["class"] = sales["cluster"].map(label_map)

    return [
        {
            "product_id": row["product_id"],
            "product_name": row["product_name"],
            "class": row["class"],
            "revenue": float(row["revenue"]),
            "margin": float(row["margin"]),
        }
        for _, row in sales.iterrows()
    ]


def _compute_cross_selling_combos(location_id: str, week_start: date, week_end: date) -> list[dict]:
    baskets = fetch_df(
        """
        select o.id as order_id, oi.product_id
        from order_items oi
        join orders o on o.id = oi.order_id
        where o.location_id = %s and o.created_at >= %s and o.created_at < %s and o.status = 'PAID'
        """,
        (location_id, week_start, week_end),
    )

    if baskets.empty:
        return []

    grouped = baskets.groupby("order_id")["product_id"].apply(list).tolist()
    grouped = [list(set(items)) for items in grouped if len(set(items)) > 1]

    # Con pocas canastas cualquier coincidencia parece "significativa" por puro azar de
    # muestra chica (ej. 2 de 11 órdenes ya da 18% de soporte). Se exige un mínimo de
    # canastas multi-producto antes de confiar en cualquier regla.
    MIN_MULTI_ITEM_BASKETS = 10
    if len(grouped) < MIN_MULTI_ITEM_BASKETS:
        return []

    encoder = TransactionEncoder()
    encoded = encoder.fit(grouped).transform(grouped)
    df_encoded = pd.DataFrame(encoded, columns=encoder.columns_)

    frequent = apriori(df_encoded, min_support=0.05, use_colnames=True)
    if frequent.empty:
        return []

    rules = association_rules(frequent, metric="lift", min_threshold=1.3)
    # Solo pares reales "si compra A también compra B" (nada de tríos/cuartetos
    # que solo son subconjuntos del mismo grupo de productos frecuentes).
    rules = rules[(rules["antecedents"].apply(len) == 1) & (rules["consequents"].apply(len) == 1)]
    # Exige un mínimo de co-ocurrencias absolutas, no solo un % sobre pocas canastas.
    min_occurrences = max(5, round(len(grouped) * 0.08))
    rules = rules[(rules["support"] * len(grouped)).round().astype(int) >= min_occurrences]
    rules = rules[rules["confidence"] >= 0.4]

    # Dedupe: A->B y B->A son la misma pareja: se queda la de mayor confianza.
    seen = {}
    for _, rule in rules.iterrows():
        pair = frozenset(list(rule["antecedents"]) + list(rule["consequents"]))
        if pair not in seen or rule["confidence"] > seen[pair]["confidence"]:
            seen[pair] = rule

    combos = sorted(seen.values(), key=lambda r: r["lift"], reverse=True)[:10]

    return [
        {
            "items": list(rule["antecedents"]) + list(rule["consequents"]),
            "support": float(rule["support"]),
            "confidence": float(rule["confidence"]),
            "lift": float(rule["lift"]),
        }
        for rule in combos
    ]


def run_weekly_analytics(location_id: str | None = None):
    """Genera Matriz ABC + combos de cross-selling de los últimos 7 días (ventana rodante,
    no semana calendario) para que siempre refleje las ventas más recientes disponibles."""
    today = date.today()
    week_end = today + timedelta(days=1)   # incluye las ventas de hoy
    week_start = today - timedelta(days=6)

    locations_query = "select id, tenant_id from locations"
    params = ()
    if location_id:
        locations_query += " where id = %s"
        params = (location_id,)
    locations = fetch_df(locations_query, params)

    processed = 0
    for _, loc in locations.iterrows():
        loc_id, tenant_id = loc["id"], loc["tenant_id"]

        abc_matrix = _compute_abc_matrix(loc_id, week_start, week_end)
        combos = _compute_cross_selling_combos(loc_id, week_start, week_end)

        execute(
            """
            insert into weekly_sales_analytics
                (tenant_id, location_id, week_start, abc_matrix, cross_selling_combos)
            values (%s, %s, %s, %s::jsonb, %s::jsonb)
            on conflict (location_id, week_start)
            do update set abc_matrix = excluded.abc_matrix,
                          cross_selling_combos = excluded.cross_selling_combos,
                          generated_at = now()
            """,
            (tenant_id, loc_id, week_start, json.dumps(abc_matrix), json.dumps(combos)),
        )
        processed += 1

    logger.info(f"Analytics semanal completado para {processed} locations")
    return {"locations_processed": processed, "week_start": str(week_start)}
