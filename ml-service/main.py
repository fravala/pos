import logging
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from forecasting import run_inventory_forecast
from analytics import run_weekly_analytics

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ml-service")

app = FastAPI(title="POS ML Service", version="1.0.0")

# El panel ADMIN (frontend POS servido en otro origen/puerto) llama estos
# endpoints directo desde el navegador, por eso se habilita CORS abierto.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

scheduler = AsyncIOScheduler()


class RecalcRequest(BaseModel):
    location_id: Optional[str] = None


@app.on_event("startup")
def start_scheduler():
    # Madrugada, domingo/lunes: predicción logística y BI semanal
    scheduler.add_job(
        run_inventory_forecast,
        trigger=CronTrigger(day_of_week="sun", hour=3, minute=0),
        id="weekly_inventory_forecast",
        replace_existing=True,
    )
    scheduler.add_job(
        run_weekly_analytics,
        trigger=CronTrigger(day_of_week="sun", hour=3, minute=30),
        id="weekly_sales_analytics",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Scheduler iniciado: forecast e insights corren domingos 3:00/3:30am")


@app.on_event("shutdown")
def stop_scheduler():
    scheduler.shutdown()


@app.get("/health")
def health():
    return {"status": "ok"}


# ============================================================
# Endpoints manuales de recálculo (botones en Panel ADMIN)
# ============================================================

@app.post("/recalculate-inventory")
def recalculate_inventory(req: RecalcRequest):
    """Fuerza la ejecución del modelo Prophet + generación de sugerencias de compra."""
    try:
        result = run_inventory_forecast(location_id=req.location_id)
        return {"ok": True, **result}
    except Exception as e:
        logger.exception("Error recalculando inventario")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/update-insights")
def update_insights(req: RecalcRequest):
    """Fuerza la ejecución de K-Means (ABC) + Apriori (cross-selling) bajo demanda."""
    try:
        result = run_weekly_analytics(location_id=req.location_id)
        return {"ok": True, **result}
    except Exception as e:
        logger.exception("Error actualizando insights")
        raise HTTPException(status_code=500, detail=str(e))
