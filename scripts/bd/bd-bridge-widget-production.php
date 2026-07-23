<?php
// ADVANTAGE BRIDGE — production widget for BD Widget Manager (HTML tab). Inline PHP only, NO custom
// functions. Render via a member-only "Custom Widget as Web Page" page (e.g. slug /enter-auctions).
//
// It runs server-side in BD: reads the logged-in member's id + real email + name, POSTs them to the
// Advantage.Bid bridge with the shared production secret over a back channel, and redirects the
// browser using ONLY the opaque code returned. The secret, the exchange response, and the member's
// data NEVER appear in the page HTML/JS/URL.
//
// BEFORE PUBLISHING: paste the production BD_BRIDGE_SECRET between the quotes below, and confirm the
// [me=...] shortcodes resolve to the member's real values on your BD install.

$app_host   = 'https://bid.advantage.bid';                 // canonical Advantage.Bid (no trailing slash)
$app_secret = 'PASTE-PRODUCTION-BD_BRIDGE_SECRET-HERE';    // must EXACTLY match Railway BD_BRIDGE_SECRET (prod)
$return_ok  = $app_host . '/auth/bd/return?code=';         // the ONLY URL prefix we will redirect to

$member_id  = trim('[me=user_id]');
$member_em  = trim('[me=email]');
$member_fn  = trim('[me=first_name]');
$member_ln  = trim('[me=last_name]');

// Allowlisted destination KEY only (never a URL from the browser).
$dest = 'dashboard';
if (isset($_GET['to']) && in_array($_GET['to'], array('dashboard','create-event','manage-events','create-auction','manage-auctions'), true)) {
    $dest = $_GET['to'];
}

if ($member_id === '' || !ctype_digit($member_id)) {
    echo '<p>Please <a href="/login/">log in</a> to enter the auctions.</p>';
} elseif ($member_em === '' || strpos($member_em, '@') === false) {
    // A real email is required so your auction account can reach you. Fail clearly, don't proceed.
    echo '<p>We could not read your account email. Please update your profile, then try again, or '
       . '<a href="' . htmlspecialchars($app_host, ENT_QUOTES) . '">visit Advantage.bid</a>.</p>';
} else {
    $redirect_url = '';
    if (function_exists('curl_init')) {
        $ch = curl_init($app_host . '/api/auth/bd/exchange');
        curl_setopt_array($ch, array(
            CURLOPT_POST => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 8,
            CURLOPT_HTTPHEADER => array('Content-Type: application/json', 'X-Bridge-Key: ' . $app_secret),
            CURLOPT_POSTFIELDS => json_encode(array(
                'bd_user_id' => $member_id,
                'dest'       => $dest,
                'email'      => $member_em,
                'first_name' => $member_fn,
                'last_name'  => $member_ln
            ))
        ));
        $resp = curl_exec($ch);
        curl_close($ch);
        $data = json_decode($resp, true);
        if (is_array($data) && isset($data['redirect_url'])) {
            $redirect_url = $data['redirect_url'];
        }
    }

    // Only ever redirect to the known Advantage.Bid return endpoint (defensive; no open redirect).
    if ($redirect_url !== '' && strpos($redirect_url, $return_ok) === 0) {
        echo '<script>window.location.replace(' . json_encode($redirect_url) . ');</script>';
        echo '<p>Entering the auctions… if you are not redirected, '
           . '<a href="' . htmlspecialchars($redirect_url, ENT_QUOTES) . '">continue here</a>.</p>';
    } else {
        echo '<p>The auction sign-in is temporarily unavailable. Please try again shortly, or '
           . '<a href="' . htmlspecialchars($app_host, ENT_QUOTES) . '">visit Advantage.bid</a>.</p>';
    }
}
?>
