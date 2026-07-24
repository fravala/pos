<?php
declare(strict_types=1);

namespace Lib;

class Auth
{
    /**
     * Valida username/password contra la tabla users y emite JWT firmado
     * con claims tenant_id / location_id / user_role (leídos por RLS en Postgres).
     *
     * @throws \RuntimeException si credenciales inválidas o usuario deshabilitado
     */
    public static function login(string $username, string $password): array
    {
        $cfg = require __DIR__ . '/../config.php';
        $pdo = Database::connection();

        // La verificación de credenciales corre con rol de servicio (bypass RLS),
        // por eso NO se aplican claims JWT antes de este SELECT.
        $stmt = $pdo->prepare(
            'select u.id, u.tenant_id, u.location_id, u.role, u.username, u.password_hash, u.status,
                    t.status as tenant_status
             from users u
             left join tenants t on t.id = u.tenant_id
             where u.username = :username limit 1'
        );
        $stmt->execute(['username' => $username]);
        $user = $stmt->fetch();

        if (!$user || $user['status'] !== 'ACTIVE') {
            throw new \RuntimeException('Credenciales inválidas');
        }

        // SUPERADMIN no pertenece a ningún tenant (tenant_id null), así que no aplica.
        if ($user['tenant_id'] !== null && $user['tenant_status'] !== 'ACTIVE') {
            throw new \RuntimeException('Esta empresa está desactivada. Contacta al administrador de la plataforma.');
        }

        if (!password_verify($password, $user['password_hash'])) {
            throw new \RuntimeException('Credenciales inválidas');
        }

        $now = time();
        $claims = [
            'sub' => $user['id'],
            'tenant_id' => $user['tenant_id'],
            'location_id' => $user['location_id'],
            'user_role' => $user['role'],
            'username' => $user['username'],
            'role' => 'authenticated', // claim estándar esperado por PostgREST/Supabase
            'iat' => $now,
            'exp' => $now + $cfg['jwt_ttl_seconds'],
        ];

        $token = JWT::encode($claims, $cfg['jwt_secret']);

        return [
            'token' => $token,
            'expires_in' => $cfg['jwt_ttl_seconds'],
            'user' => [
                'id' => $user['id'],
                'tenant_id' => $user['tenant_id'],
                'location_id' => $user['location_id'],
                'role' => $user['role'],
                'username' => $user['username'],
            ],
        ];
    }

    /**
     * Extrae y valida el Bearer token de la request actual.
     * Aplica los claims a la sesión PDO para que RLS los use.
     *
     * @throws \RuntimeException si no hay token o es inválido
     */
    public static function requireAuth(): array
    {
        $cfg = require __DIR__ . '/../config.php';
        $headers = getallheaders();
        $authHeader = $headers['Authorization'] ?? $headers['authorization'] ?? '';

        if (!preg_match('/^Bearer\s+(.+)$/i', $authHeader, $matches)) {
            http_response_code(401);
            throw new \RuntimeException('Falta Authorization: Bearer <token>');
        }

        try {
            $claims = JWT::decode($matches[1], $cfg['jwt_secret']);
        } catch (\RuntimeException $e) {
            http_response_code(401);
            throw $e;
        }

        Database::applyJwtClaims(Database::connection(), $claims);

        return $claims;
    }

    /** Lanza 403 si el rol del claim no está en $allowedRoles */
    public static function requireRole(array $claims, array $allowedRoles): void
    {
        if (!in_array($claims['user_role'] ?? null, $allowedRoles, true)) {
            http_response_code(403);
            throw new \RuntimeException('No autorizado para este recurso');
        }
    }
}
