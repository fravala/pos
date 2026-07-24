# Inyección de Cross-Selling en el System Prompt (n8n + Evolution API)

## Objetivo
Antes de que el LLM responda a un mensaje de WhatsApp, el workflow de n8n debe
consultar `weekly_sales_analytics` para obtener los combos de venta cruzada
(`cross_selling_combos`) más recientes de la sucursal, y añadirlos como contexto
dinámico al System Prompt para que el modelo sugiera up-selling de forma natural.

## Paso 1 — Resolver location_id
El nodo previo (Evolution API webhook) entrega el número que recibió el mensaje.
Resuélvelo contra `bot_instances.phone_number` para obtener `location_id`.

```sql
select location_id
from bot_instances
where phone_number = :incoming_phone_number
limit 1;
```

## Paso 2 — SELECT a weekly_sales_analytics (última semana generada)

```sql
select abc_matrix, cross_selling_combos, week_start
from weekly_sales_analytics
where location_id = :location_id
order by week_start desc
limit 1;
```

Esta tabla la llena el microservicio FastAPI (`analytics.py`, cron semanal o
botón "Actualizar Insights"). `cross_selling_combos` tiene la forma:

```json
[
  { "items": ["<product_id_1>", "<product_id_2>"], "support": 0.08, "confidence": 0.62, "lift": 2.1 }
]
```

## Paso 3 — Nodo n8n: Resolver nombres de producto
`cross_selling_combos` solo trae `product_id`. Antes de inyectar al prompt,
haz un JOIN/lookup contra `products` para traducir IDs a nombres legibles:

```sql
select id, name from products where id = any(:product_ids);
```

## Paso 4 — Construir el bloque de contexto del System Prompt

En un nodo "Set" o "Code" de n8n, arma un bloque de texto como este y
concaténalo al System Prompt antes de la llamada al LLM:

```
CONTEXTO DE VENTA CRUZADA (usa esto para sugerir up-selling de forma natural,
solo cuando el cliente ya eligió al menos uno de los productos de un combo,
nunca insistas más de una vez por conversación):

- Quienes piden "Pizza Pepperoni" frecuentemente agregan "Refresco 600ml" (confianza 62%).
- Quienes piden "Hot Dog Especial" frecuentemente agregan "Papas Fritas" (confianza 55%).
```

Genera estas líneas iterando `cross_selling_combos` ordenado por `lift` descendente
(mayor lift = asociación más fuerte, no solo coincidencia por popularidad),
tomando máximo 3-5 combos para no saturar el prompt.

## Paso 5 — Function calling
Una vez el cliente confirma su pedido completo, el LLM debe invocar la función
`create_order` (ver `function_schema_create_order.json`) con `location_id`,
`items` (incluyendo `removed_ingredients` / `added_extras`), `customer_phone`
y `payment_method`. n8n recibe el function call, valida el schema, y hace el
POST correspondiente al backend (inserta en `orders` + `order_items`; el
trigger `fn_deduct_inventory` de Supabase se encarga de descontar inventario).

## Notas de seguridad
- El nodo n8n que ejecuta estos SELECTs debe usar credenciales de servicio
  (rol con bypass de RLS) — igual que el microservicio ML — porque no hay
  un usuario "CASHIER/ADMIN" autenticado en esta conversación, solo el bot.
- Nunca expongas `unit_cost` ni `total_cost` (view_product_costs) al cliente
  final vía WhatsApp; esos campos son solo para el Panel ADMIN.
