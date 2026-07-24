// Cliente API — llama al backend PHP y a Supabase REST (PostgREST) con el JWT propio
import { getSessionValue } from './db.js';

const PHP_API_BASE = window.__ENV__?.PHP_API_BASE || 'http://localhost:8000/api';
const SUPABASE_URL = window.__ENV__?.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.__ENV__?.SUPABASE_ANON_KEY || '';

async function authHeaders() {
  const token = await getSessionValue('jwt');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function login(username, password) {
  const res = await fetch(`${PHP_API_BASE}/login.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Login fallido');
  return res.json();
}

export async function phpPost(endpoint, body) {
  const res = await fetch(`${PHP_API_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json()).error || 'Error de red');
  return res.json();
}

// --- Acceso directo a Supabase REST (PostgREST) para lecturas de catálogo ---
export async function supabaseGet(path) {
  const token = await getSessionValue('jwt');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error('Error consultando Supabase');
  return res.json();
}

export async function supabasePost(path, body) {
  const token = await getSessionValue('jwt');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Error escribiendo en Supabase');
  return res.json();
}

export async function supabasePatch(path, body) {
  const token = await getSessionValue('jwt');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Error actualizando Supabase');
  return res.json();
}

export async function supabaseDelete(path) {
  const token = await getSessionValue('jwt');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) throw new Error('Error eliminando en Supabase');
}

export function isOnline() {
  return navigator.onLine;
}
