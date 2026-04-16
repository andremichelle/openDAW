<?php
$origin = $_SERVER["HTTP_ORIGIN"] ?? "";
$allowed = ["https://opendaw.studio", "https://www.opendaw.studio", "http://localhost", "https://localhost"];
$match = false;
foreach ($allowed as $prefix) {
    if (str_starts_with($origin, $prefix)) {
        $match = true;
        break;
    }
}
if (!$match) {
    http_response_code(403);
    exit;
}
header("Access-Control-Allow-Origin: $origin");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");
header("Cross-Origin-Resource-Policy: cross-origin");

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    http_response_code(204);
    exit;
}
if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    http_response_code(405);
    exit;
}

$body = json_decode(file_get_contents("php://input"), true);
$id = $body["id"] ?? "";
if (!is_string($id) || strlen($id) < 8 || strlen($id) > 64) {
    http_response_code(400);
    exit;
}

$date = date("Y-m-d");
$file = __DIR__ . "/visitors.json";
$fp = fopen($file, "c+");
flock($fp, LOCK_EX);
$raw = stream_get_contents($fp);
$data = $raw ? json_decode($raw, true) : [];
if (!isset($data[$date])) {
    $data[$date] = [];
}
if (!in_array($id, $data[$date], true)) {
    $data[$date][] = $id;
}
rewind($fp);
ftruncate($fp, 0);
fwrite($fp, json_encode($data));
flock($fp, LOCK_UN);
fclose($fp);
http_response_code(204);
