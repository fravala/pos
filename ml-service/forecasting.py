"""
Predicción logística (Prophet):
1. Lee historial de order_items por producto/location.
2. Predice demanda futura (próximos self_purchase_lead_time / lead time de proveedor días).
3. Traduce demanda de productos a insumos brutos vía recipes_bom.
4. Cruza contra inventory_stock, evalúa restock_mode y lead times.
5. Guarda Sugerencias de Compra Exactas en purchase_suggestions.
"""
import logging
from prophet import Prophet
from db import fetch_df, execute, execute_many

logger = logging.getLogger("forecasting")

FORECAST_HORIZON_DAYS_DEFAULT = 7


def _forecast_product_demand(history_df, horizon_days: int) -> float:
    """Entrena Prophet sobre ventas diarias de un producto y devuelve demanda total predicha."""
    if len(history_df) < 5:
        # Historial insuficiente: usa promedio simple como fallback conservador
        return float(history_df["y"].mean() or 0) * horizon_days

    model = Prophet(
        daily_seasonality=False,
        weekly_seasonality=True,
        yearly_seasonality=False,
        interval_width=0.8,
    )
    model.fit(history_df)
    future = model.make_future_dataframe(periods=horizon_days)
    forecast = model.predict(future)
    predicted = forecast.tail(horizon_days)["yhat"].clip(lower=0).sum()
    return float(predicted)


def run_inventory_forecast(location_id: str | None = None):
    """Ejecuta el pipeline completo de predicción + sugerencias de compra.
    Si location_id es None, corre para todas las locations activas."""

    locations_query = "select id, tenant_id from locations"
    params = ()
    if location_id:
        locations_query += " where id = %s"
        params = (location_id,)
    locations = fetch_df(locations_query, params)

    total_suggestions = 0

    for _, loc in locations.iterrows():
        loc_id, tenant_id = loc["id"], loc["tenant_id"]

        # Cada corrida reemplaza las sugerencias pendientes anteriores de esta
        # sucursal — evita acumular duplicados cuando se recalcula más de una vez.
        execute(
            "delete from purchase_suggestions where location_id = %s and status = 'PENDING'",
            (loc_id,),
        )

        products = fetch_df(
            "select id, name from products where tenant_id = %s and active = true",
            (tenant_id,),
        )

        # demanda_predicha[product_id] = unidades esperadas en el horizonte
        demand_by_product = {}

        for _, prod in products.iterrows():
            history = fetch_df(
                """
                select date_trunc('day', oi.created_at)::date as ds,
                       sum(oi.quantity)::float as y
                from order_items oi
                join orders o on o.id = oi.order_id
                where oi.product_id = %s and o.location_id = %s and o.status = 'PAID'
                group by 1
                order by 1
                """,
                (prod["id"], loc_id),
            )
            if history.empty:
                continue
            demand_by_product[prod["id"]] = _forecast_product_demand(
                history, FORECAST_HORIZON_DAYS_DEFAULT
            )

        if not demand_by_product:
            continue

        # Traduce demanda de productos -> insumos brutos vía recipes_bom
        raw_material_demand = {}  # ingredient_id -> qty necesaria
        for product_id, demand_qty in demand_by_product.items():
            bom = fetch_df(
                "select ingredient_id, quantity_to_deduct from recipes_bom where product_id = %s",
                (product_id,),
            )
            for _, row in bom.iterrows():
                raw_material_demand[row["ingredient_id"]] = (
                    raw_material_demand.get(row["ingredient_id"], 0)
                    + row["quantity_to_deduct"] * demand_qty
                )

        if not raw_material_demand:
            continue

        # Cruza contra stock actual + evalúa restock_mode/lead time
        catalog_ids = tuple(raw_material_demand.keys())
        catalog_df = fetch_df(
            """
            select ic.id, ic.restock_mode, ic.vendor_id, ic.self_purchase_lead_time,
                   coalesce(s.current_stock, 0) as current_stock,
                   coalesce(s.safety_stock, 0) as safety_stock
            from inventory_catalog ic
            left join inventory_stock s on s.catalog_id = ic.id and s.location_id = %s
            where ic.id = any(%s::uuid[])
            """,
            (loc_id, [str(c) for c in catalog_ids]),
        )

        rows_to_insert = []
        for _, cat in catalog_df.iterrows():
            needed = raw_material_demand[cat["id"]]
            projected_stock = cat["current_stock"] - needed
            deficit = cat["safety_stock"] - projected_stock

            if deficit <= 0:
                continue  # stock proyectado cubre demanda + colchón de seguridad

            reasoning = (
                f"Demanda proyectada {needed:.2f} en {FORECAST_HORIZON_DAYS_DEFAULT}d, "
                f"stock actual {cat['current_stock']:.2f}, stock de seguridad {cat['safety_stock']:.2f}."
            )
            rows_to_insert.append((
                tenant_id, loc_id, cat["id"], round(deficit, 4),
                cat["restock_mode"], cat["vendor_id"], reasoning,
            ))

        if rows_to_insert:
            execute_many(
                """
                insert into purchase_suggestions
                    (tenant_id, location_id, catalog_id, suggested_qty, restock_mode, vendor_id, reasoning)
                values (%s, %s, %s, %s, %s, %s, %s)
                """,
                rows_to_insert,
            )
            total_suggestions += len(rows_to_insert)

    logger.info(f"Forecast completado: {total_suggestions} sugerencias de compra generadas")
    return {"suggestions_generated": total_suggestions}
