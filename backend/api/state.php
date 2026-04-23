<?php
header('Content-Type: application/json; charset=utf-8');

echo json_encode([
    'ok' => true,
    'message' => 'PHP API works'
], JSON_UNESCAPED_UNICODE);