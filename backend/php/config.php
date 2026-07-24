<?php
declare(strict_types=1);

// Carga variables desde entorno (.env cargado por servidor o export manual)
if (!function_exists('env')) {
    function env(string $key, ?string $default = null): ?string
    {
        $value = getenv($key);
        return $value !== false ? $value : $default;
    }
}

return [
    'db' => [
        'host' => env('DB_HOST', 'localhost'),
        'port' => env('DB_PORT', '5432'),
        'name' => env('DB_NAME', 'postgres'),
        'user' => env('DB_USER', 'postgres'),
        'pass' => env('DB_PASS', ''),
    ],
    // Debe ser el MISMO secreto configurado en Supabase (Project Settings > API > JWT Secret)
    'jwt_secret' => env('SUPABASE_JWT_SECRET', 'CHANGE_ME'),
    'jwt_ttl_seconds' => (int) env('JWT_TTL_SECONDS', '28800'), // 8h turno de caja
];
