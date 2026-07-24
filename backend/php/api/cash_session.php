<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Lib\Auth;
use Lib\Database;

try {
    $claims = Auth::requireAuth();
} catch (\RuntimeException $e) {
    json_error($e->getMessage(), 401);
}

$pdo = Database::connection();
$action = $_GET['action'] ?? '';

// --- Abrir turno: declara fondo inicial obligatorio ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'open') {
    $input = json_input();
    $opening = (float)($input['opening_balance'] ?? -1);
    if ($opening < 0) {
        json_error('opening_balance obligatorio (>= 0)', 422);
    }
    if (empty($claims['location_id'])) {
        json_error('Usuario sin location_id asignado', 422);
    }

    $stmt = $pdo->prepare(
        'insert into cash_sessions (location_id, opened_by, opening_balance)
         values (:location_id, :opened_by, :opening_balance)
         returning id, location_id, opened_at, opening_balance, status'
    );
    $stmt->execute([
        'location_id' => $claims['location_id'],
        'opened_by' => $claims['sub'],
        'opening_balance' => $opening,
    ]);
    echo json_encode($stmt->fetch());
    exit;
}

// --- Registrar ingreso/retiro manual (ADDITION / WITHDRAWAL) ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'transaction') {
    $input = json_input();
    $sessionId = $input['session_id'] ?? null;
    $type = $input['type'] ?? '';
    $amount = (float)($input['amount'] ?? 0);
    $description = $input['description'] ?? null;

    if (!$sessionId || !in_array($type, ['ADDITION', 'WITHDRAWAL'], true) || $amount <= 0) {
        json_error('session_id, type (ADDITION|WITHDRAWAL), amount > 0 requeridos', 422);
    }

    $stmt = $pdo->prepare(
        'insert into cash_transactions (session_id, type, amount, description)
         values (:session_id, :type, :amount, :description)
         returning id, session_id, type, amount, created_at'
    );
    $stmt->execute([
        'session_id' => $sessionId,
        'type' => $type,
        'amount' => $amount,
        'description' => $description,
    ]);
    echo json_encode($stmt->fetch());
    exit;
}

// --- Corte Z: cierra sesión, calcula faltante/sobrante vía trigger fn_close_cash_session ---
if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'close') {
    $input = json_input();
    $sessionId = $input['session_id'] ?? null;
    $actualBalance = $input['actual_balance'] ?? null;

    if (!$sessionId || $actualBalance === null) {
        json_error('session_id y actual_balance requeridos', 422);
    }

    $stmt = $pdo->prepare(
        "update cash_sessions
         set status = 'CLOSED', closed_at = now(), actual_balance = :actual_balance
         where id = :id and status = 'OPEN'
         returning id, opening_balance, expected_balance, actual_balance, discrepancy, closed_at"
    );
    $stmt->execute(['id' => $sessionId, 'actual_balance' => $actualBalance]);
    $row = $stmt->fetch();

    if (!$row) {
        json_error('Sesión no encontrada o ya cerrada', 404);
    }
    echo json_encode($row);
    exit;
}

json_error('Acción inválida. Usa ?action=open|transaction|close', 400);
