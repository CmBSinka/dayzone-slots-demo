<?php
// Minimal backend stub used to verify that the PHP side is reachable.
header('Content-Type: application/json; charset=utf-8');

echo json_encode([
    'ok' => true,
    'message' => 'PHP API works'
], JSON_UNESCAPED_UNICODE);
