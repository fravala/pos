<?php
declare(strict_types=1);

namespace Lib;

class Database
{
    private static ?\PDO $instance = null;

    public static function connection(): \PDO
    {
        if (self::$instance === null) {
            $cfg = require __DIR__ . '/../config.php';
            $dsn = sprintf(
                'pgsql:host=%s;port=%s;dbname=%s',
                $cfg['db']['host'],
                $cfg['db']['port'],
                $cfg['db']['name']
            );
            self::$instance = new \PDO($dsn, $cfg['db']['user'], $cfg['db']['pass'], [
                \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
                \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            ]);
        }
        return self::$instance;
    }

    /**
     * Aplica el JWT claim del usuario autenticado a la sesión Postgres actual
     * para que las políticas RLS (current_setting('request.jwt.claims')) apliquen.
     * Debe llamarse una vez por conexión/request, tras autenticar.
     */
    public static function applyJwtClaims(\PDO $pdo, array $claims): void
    {
        $json = json_encode($claims, JSON_UNESCAPED_SLASHES);
        $stmt = $pdo->prepare("select set_config('request.jwt.claims', :claims, false)");
        $stmt->execute(['claims' => $json]);
    }
}
