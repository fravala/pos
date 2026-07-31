<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Lib\Auth;
use Lib\Database;

try {
    $claims = Auth::requireAuth();
    Auth::requireRole($claims, ['SUPERADMIN', 'ADMIN']);
} catch (\RuntimeException $e) {
    json_error($e->getMessage(), $e->getCode() === 403 ? 403 : 401);
}

$pdo = Database::connection();
$action = $_GET['action'] ?? '';
$isSuperadmin = ($claims['user_role'] ?? null) === 'SUPERADMIN';

// --- Listar usuarios del propio tenant ---
if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'list') {
    $stmt = $pdo->prepare(
        'select id, username, role, status, location_id, created_at
         from users
         where tenant_id = :tenant_id
         order by created_at asc'
    );
    $stmt->execute(['tenant_id' => $claims['tenant_id']]);
    echo json_encode($stmt->fetchAll());
    exit;
}

// --- Cambiar rol (ADMIN/CASHIER/KITCHEN, nunca SUPERADMIN desde aquí) ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'update_role') {
    $input = json_input();
    $userId = $input['user_id'] ?? null;
    $role = (string)($input['role'] ?? '');

    if (!$userId || !in_array($role, ['ADMIN', 'CASHIER', 'KITCHEN'], true)) {
        json_error('user_id y role (ADMIN|CASHIER|KITCHEN) requeridos', 422);
    }
    if ($userId === $claims['sub']) {
        json_error('No puedes cambiar tu propio rol', 422);
    }

    // SUPERADMIN puede actuar sobre usuarios de cualquier empresa; ADMIN solo la suya.
    $sql = $isSuperadmin
        ? 'update users set role = :role where id = :id returning id, username, role, status'
        : 'update users set role = :role where id = :id and tenant_id = :tenant_id returning id, username, role, status';
    $params = ['role' => $role, 'id' => $userId];
    if (!$isSuperadmin) $params['tenant_id'] = $claims['tenant_id'];

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $row = $stmt->fetch();
    if (!$row) json_error('Usuario no encontrado', 404);
    echo json_encode($row);
    exit;
}

// --- Activar / desactivar usuario ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'toggle_status') {
    $input = json_input();
    $userId = $input['user_id'] ?? null;
    $status = (string)($input['status'] ?? '');

    if (!$userId || !in_array($status, ['ACTIVE', 'DISABLED'], true)) {
        json_error('user_id y status (ACTIVE|DISABLED) requeridos', 422);
    }
    if ($userId === $claims['sub']) {
        json_error('No puedes desactivar tu propia cuenta', 422);
    }

    $sql = $isSuperadmin
        ? 'update users set status = :status where id = :id returning id, username, role, status'
        : 'update users set status = :status where id = :id and tenant_id = :tenant_id returning id, username, role, status';
    $params = ['status' => $status, 'id' => $userId];
    if (!$isSuperadmin) $params['tenant_id'] = $claims['tenant_id'];

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $row = $stmt->fetch();
    if (!$row) json_error('Usuario no encontrado', 404);
    echo json_encode($row);
    exit;
}

// --- Resetear contraseña ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'reset_password') {
    $input = json_input();
    $userId = $input['user_id'] ?? null;
    $newPassword = (string)($input['new_password'] ?? '');

    if (!$userId || strlen($newPassword) < 6) {
        json_error('user_id y new_password (mínimo 6 caracteres) requeridos', 422);
    }

    $sql = $isSuperadmin
        ? 'update users set password_hash = :password_hash where id = :id returning id, username'
        : 'update users set password_hash = :password_hash where id = :id and tenant_id = :tenant_id returning id, username';
    $params = ['password_hash' => password_hash($newPassword, PASSWORD_BCRYPT), 'id' => $userId];
    if (!$isSuperadmin) $params['tenant_id'] = $claims['tenant_id'];

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $row = $stmt->fetch();
    if (!$row) json_error('Usuario no encontrado', 404);
    echo json_encode($row);
    exit;
}

// --- Configurar PIN propio de confirmación (para modificar órdenes cobradas) ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'set_pin') {
    $input = json_input();
    $pin = (string)($input['pin'] ?? '');

    if (!preg_match('/^\d{4,6}$/', $pin)) {
        json_error('El PIN debe ser numérico de 4 a 6 dígitos', 422);
    }

    $stmt = $pdo->prepare('update users set pin_hash = :pin_hash where id = :id returning id');
    $stmt->execute(['pin_hash' => password_hash($pin, PASSWORD_BCRYPT), 'id' => $claims['sub']]);
    if (!$stmt->fetch()) json_error('Usuario no encontrado', 404);
    echo json_encode(['ok' => true]);
    exit;
}

// --- Verificar PIN propio (confirmación para modificar orden cobrada) ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'verify_pin') {
    $input = json_input();
    $pin = (string)($input['pin'] ?? '');

    $stmt = $pdo->prepare('select pin_hash from users where id = :id');
    $stmt->execute(['id' => $claims['sub']]);
    $row = $stmt->fetch();

    $valid = $row && $row['pin_hash'] && password_verify($pin, $row['pin_hash']);
    echo json_encode(['valid' => (bool)$valid, 'pin_configured' => (bool)($row && $row['pin_hash'])]);
    exit;
}

json_error('Acción inválida. Usa ?action=list|update_role|toggle_status|reset_password|set_pin|verify_pin', 400);
