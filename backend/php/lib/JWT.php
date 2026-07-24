<?php
declare(strict_types=1);

namespace Lib;

/**
 * Implementación mínima JWT HS256 (sin dependencias externas).
 * Compatible con el JWT_SECRET de Supabase para que PostgREST/RLS
 * (current_setting('request.jwt.claims')) validen los mismos tokens.
 */
class JWT
{
    public static function encode(array $payload, string $secret): string
    {
        $header = self::base64UrlEncode(json_encode(['typ' => 'JWT', 'alg' => 'HS256']));
        $body = self::base64UrlEncode(json_encode($payload));
        $signature = self::sign("$header.$body", $secret);
        return "$header.$body.$signature";
    }

    /**
     * Decodifica y valida firma + expiración. Lanza excepción si el token es inválido.
     */
    public static function decode(string $token, string $secret): array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            throw new \RuntimeException('Token malformado');
        }
        [$header, $body, $signature] = $parts;

        $expected = self::sign("$header.$body", $secret);
        if (!hash_equals($expected, $signature)) {
            throw new \RuntimeException('Firma inválida');
        }

        $payload = json_decode(self::base64UrlDecode($body), true);
        if (!is_array($payload)) {
            throw new \RuntimeException('Payload inválido');
        }

        if (isset($payload['exp']) && time() >= (int) $payload['exp']) {
            throw new \RuntimeException('Token expirado');
        }

        return $payload;
    }

    private static function sign(string $data, string $secret): string
    {
        $hash = hash_hmac('sha256', $data, $secret, true);
        return self::base64UrlEncode($hash);
    }

    private static function base64UrlEncode(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function base64UrlDecode(string $data): string
    {
        $padded = str_pad($data, strlen($data) % 4 === 0 ? strlen($data) : strlen($data) + (4 - strlen($data) % 4), '=');
        return base64_decode(strtr($padded, '-_', '+/'));
    }
}
