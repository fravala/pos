<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Lib\Auth;

try {
    $claims = Auth::requireAuth();
} catch (\RuntimeException $e) {
    json_error($e->getMessage(), 401);
}

echo json_encode([
    'tenant_id' => $claims['tenant_id'],
    'location_id' => $claims['location_id'],
    'user_role' => $claims['user_role'],
    'username' => $claims['username'],
]);
