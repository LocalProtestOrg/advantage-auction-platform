<?php
// CAP2_BRIDGE_POC_TEMP — temporary Option B bridge test widget for BD Widget Manager (HTML tab).
// Paste into a NEW widget; render via a NEW "Custom Widget as Web Page" page (access: Only Allow
// Members). Delete both after testing. Inline PHP only — NO custom function declarations.
//
// It: reads the logged-in member id server-side, POSTs to the ISOLATED Railway PoC with a temporary
// server-side secret, and redirects the browser using ONLY the opaque code Railway returns. The
// secret never appears in the page HTML/JS/URL. Replace the two placeholders before testing.

$poc_host   = 'https://REPLACE-WITH-RAILWAY-POC-HOST';   // e.g. https://bd-bridge-poc.up.railway.app (NO trailing slash)
$poc_secret = 'REPLACE-WITH-TEMP-POC-SECRET';            // temporary PoC secret; must match the server's POC_BRIDGE_SECRET

$member_id = trim('[me=user_id]');
if ($member_id === '' || !ctype_digit($member_id)) {
    echo '<p>Please <a href="/login/">log in</a> to continue.</p>';
} else {
    // Allowlisted destination KEY only — never a URL supplied by the browser.
    $dest = 'dashboard';
    if (isset($_GET['to']) && in_array($_GET['to'], array('dashboard', 'create-event', 'manage-events', 'create-auction', 'manage-auctions'), true)) {
        $dest = $_GET['to'];
    }

    $redirect_url = '';
    if (function_exists('curl_init')) {
        $ch = curl_init($poc_host . '/auth/bd/exchange');
        curl_setopt_array($ch, array(
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_HTTPHEADER => array('Content-Type: application/json', 'X-Bridge-Key: ' . $poc_secret),
            CURLOPT_POSTFIELDS => json_encode(array('bd_user_id' => $member_id, 'dest' => $dest))
        ));
        $resp = curl_exec($ch);
        curl_close($ch);
        $data = json_decode($resp, true);
        if (is_array($data) && isset($data['redirect_url'])) {
            $redirect_url = $data['redirect_url'];
        }
    }

    // Only redirect if the returned URL points at our known PoC host (defensive; no open redirect).
    if ($redirect_url !== '' && strpos($redirect_url, $poc_host . '/auth/bd/return?code=') === 0) {
        echo '<script>window.location.replace(' . json_encode($redirect_url) . ');</script>';
        echo '<p>Continuing… if you are not redirected, <a href="' . htmlspecialchars($redirect_url, ENT_QUOTES) . '">click here</a>.</p>';
    } else {
        echo '<p>Bridge unavailable right now. Please try again.</p>';
    }
}
?>
