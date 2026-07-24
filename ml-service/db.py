import os
import psycopg2
import psycopg2.extras
from contextlib import contextmanager
from dotenv import load_dotenv

load_dotenv()

DB_DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/postgres",
)


@contextmanager
def get_conn():
    """Conexión directa a Postgres con rol de servicio — bypassa RLS (proceso de backend confiable)."""
    conn = psycopg2.connect(DB_DSN)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def fetch_df(query: str, params: tuple = ()):
    import pandas as pd
    with get_conn() as conn:
        return pd.read_sql(query, conn, params=params)


def execute(query: str, params: tuple = ()):
    with get_conn() as conn:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(query, params)
            if cur.description:
                return cur.fetchall()
            return None


def execute_many(query: str, param_list: list):
    with get_conn() as conn:
        with conn.cursor() as cur:
            psycopg2.extras.execute_batch(cur, query, param_list)
