<?php
declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

use Lib\Auth;

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_error('Método no permitido', 405);
}

$input = json_input();
$username = trim((string)($input['username'] ?? ''));
$password = (string)($input['password'] ?? '');

if ($username === '' || $password === '') {
    json_error('username y password son requeridos', 422);
}

try {
    $result = Auth::login($username, $password);
    echo json_encode($result);
} catch (\RuntimeException $e) {
    json_error($e->getMessage(), 401);
}
