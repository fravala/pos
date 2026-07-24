<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Lib\Auth;
use Lib\Database;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

try {
    $claims = Auth::requireAuth();
    Auth::requireRole($claims, ['SUPERADMIN', 'ADMIN']);
} catch (\RuntimeException $e) {
    json_error($e->getMessage(), $e->getCode() === 403 ? 403 : 401);
}

$input = json_input();
$username = trim((string)($input['username'] ?? ''));
$password = (string)($input['password'] ?? '');
$role = (string)($input['role'] ?? 'CASHIER');
$locationId = $input['location_id'] ?? null;

if ($username === '' || strlen($password) < 6) {
    json_error('username requerido, password mínimo 6 caracteres', 422);
}
if (!in_array($role, ['ADMIN', 'CASHIER', 'KITCHEN'], true)) {
    json_error('role inválido', 422);
}

$pdo = Database::connection();
$stmt = $pdo->prepare(
    'insert into users (tenant_id, location_id, role, username, password_hash)
     values (:tenant_id, :location_id, :role, :username, :password_hash)
     returning id, tenant_id, location_id, role, username'
);
$stmt->execute([
    'tenant_id' => $claims['tenant_id'],
    'location_id' => $locationId,
    'role' => $role,
    'username' => $username,
    'password_hash' => password_hash($password, PASSWORD_BCRYPT),
]);

echo json_encode($stmt->fetch());
