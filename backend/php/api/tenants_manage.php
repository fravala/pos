<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Lib\Auth;
use Lib\Database;

try {
    $claims = Auth::requireAuth();
    Auth::requireRole($claims, ['SUPERADMIN']);
} catch (\RuntimeException $e) {
    json_error($e->getMessage(), $e->getCode() === 403 ? 403 : 401);
}

$pdo = Database::connection();
$action = $_GET['action'] ?? '';

// --- Listar empresas con conteo de sucursales y usuarios ---
if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'list') {
    $stmt = $pdo->query(
        "select t.id, t.name, t.status, t.created_at,
                (select count(*) from locations l where l.tenant_id = t.id) as location_count,
                (select count(*) from users u where u.tenant_id = t.id) as user_count
         from tenants t
         order by t.created_at desc"
    );
    echo json_encode($stmt->fetchAll());
    exit;
}

// --- Crear empresa nueva + primera sucursal + primer usuario ADMIN ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'create') {
    $input = json_input();
    $tenantName = trim((string)($input['tenant_name'] ?? ''));
    $locationName = trim((string)($input['location_name'] ?? ''));
    $adminUsername = trim((string)($input['admin_username'] ?? ''));
    $adminPassword = (string)($input['admin_password'] ?? '');

    if ($tenantName === '' || $locationName === '' || $adminUsername === '' || strlen($adminPassword) < 6) {
        json_error('tenant_name, location_name, admin_username y admin_password (mínimo 6 caracteres) son requeridos', 422);
    }

    try {
        $pdo->beginTransaction();

        $stmt = $pdo->prepare('insert into tenants (name) values (:name) returning id');
        $stmt->execute(['name' => $tenantName]);
        $tenantId = $stmt->fetchColumn();

        $stmt = $pdo->prepare(
            'insert into locations (tenant_id, name) values (:tenant_id, :name) returning id'
        );
        $stmt->execute(['tenant_id' => $tenantId, 'name' => $locationName]);
        $locationId = $stmt->fetchColumn();

        $stmt = $pdo->prepare(
            'insert into users (tenant_id, location_id, role, username, password_hash)
             values (:tenant_id, :location_id, \'ADMIN\', :username, :password_hash)
             returning id'
        );
        $stmt->execute([
            'tenant_id' => $tenantId,
            'location_id' => $locationId,
            'username' => $adminUsername,
            'password_hash' => password_hash($adminPassword, PASSWORD_BCRYPT),
        ]);
        $userId = $stmt->fetchColumn();

        $pdo->commit();

        echo json_encode([
            'tenant_id' => $tenantId,
            'location_id' => $locationId,
            'admin_user_id' => $userId,
        ]);
    } catch (\Throwable $e) {
        $pdo->rollBack();
        if (str_contains($e->getMessage(), 'duplicate') || str_contains($e->getMessage(), 'unique')) {
            json_error('El nombre de usuario ya existe', 422);
        }
        json_error('Error creando la empresa: ' . $e->getMessage(), 500);
    }
    exit;
}

// --- Renombrar empresa ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'update') {
    $input = json_input();
    $tenantId = $input['tenant_id'] ?? null;
    $name = trim((string)($input['name'] ?? ''));

    if (!$tenantId || $name === '') {
        json_error('tenant_id y name requeridos', 422);
    }

    $stmt = $pdo->prepare('update tenants set name = :name where id = :id returning id, name');
    $stmt->execute(['name' => $name, 'id' => $tenantId]);
    $row = $stmt->fetch();
    if (!$row) json_error('Empresa no encontrada', 404);
    echo json_encode($row);
    exit;
}

// --- Activar / desactivar empresa (bloquea login de todos sus usuarios) ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'toggle_status') {
    $input = json_input();
    $tenantId = $input['tenant_id'] ?? null;
    $status = (string)($input['status'] ?? '');

    if (!$tenantId || !in_array($status, ['ACTIVE', 'DISABLED'], true)) {
        json_error('tenant_id y status (ACTIVE|DISABLED) requeridos', 422);
    }

    $stmt = $pdo->prepare('update tenants set status = :status where id = :id returning id, name, status');
    $stmt->execute(['status' => $status, 'id' => $tenantId]);
    $row = $stmt->fetch();
    if (!$row) json_error('Empresa no encontrada', 404);
    echo json_encode($row);
    exit;
}

json_error('Acción inválida. Usa ?action=list|create|update|toggle_status', 400);
