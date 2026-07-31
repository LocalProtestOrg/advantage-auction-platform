<?php
// ADVANTAGE BRIDGE — production widget for BD Widget Manager (HTML tab). Inline PHP only, NO custom
// functions. Render via a member-only "Custom Widget as Web Page" page (e.g. slug /enter-auctions).
//
// It runs server-side in BD: reads the logged-in member's id + real email + name, POSTs them to the
// Advantage.Bid bridge with the shared production secret over a back channel, and redirects the
// browser using ONLY the opaque code returned. The secret, the exchange response, and the member's
// data NEVER appear in the page HTML/JS/URL.
//
// The output is a single FULL-VIEWPORT neutral overlay ("Opening your dashboard…") that paints
// immediately and covers BD's dashboard chrome, so the member never sees the old shell flash before
// the redirect fires. The bridge protocol itself is unchanged. On any failure the overlay shows a
// neutral recovery message + link instead of redirecting.
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

// Resolve the outcome server-side BEFORE emitting anything: 'redirect' | 'login' | 'email' | 'error'.
$outcome = 'error';
$redirect_url = '';
if ($member_id === '' || !ctype_digit($member_id)) {
    $outcome = 'login';
} elseif ($member_em === '' || strpos($member_em, '@') === false) {
    $outcome = 'email';
} else {
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
        $outcome = 'redirect';
    } else {
        $outcome = 'error';
    }
}

$host_link = htmlspecialchars($app_host, ENT_QUOTES);
?>
<style>
/* Full-viewport neutral cover — hides BD's dashboard chrome the instant this widget paints. */
#adv-bridge-overlay{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;
  justify-content:center;background:#0e1116;color:#e8eaed;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  padding:24px;text-align:center;-webkit-font-smoothing:antialiased;}
#adv-bridge-overlay .adv-box{max-width:420px}
#adv-bridge-overlay .adv-spin{width:34px;height:34px;margin:0 auto 18px;border-radius:50%;
  border:3px solid rgba(255,255,255,.18);border-top-color:#e8eaed;animation:adv-spin .8s linear infinite}
#adv-bridge-overlay p{margin:8px 0;font-size:15px;line-height:1.5;color:#c7ccd4}
#adv-bridge-overlay .adv-title{font-size:18px;font-weight:600;color:#fff;margin-bottom:4px}
#adv-bridge-overlay a{color:#8ab4ff;text-decoration:underline}
@keyframes adv-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){#adv-bridge-overlay .adv-spin{animation:none}}
</style>
<div id="adv-bridge-overlay"><div class="adv-box">
<?php if ($outcome === 'redirect') { ?>
  <div class="adv-spin" aria-hidden="true"></div>
  <p class="adv-title">Opening your dashboard…</p>
  <p>If you are not redirected automatically,
     <a href="<?php echo htmlspecialchars($redirect_url, ENT_QUOTES); ?>">continue here</a>.</p>
  <script>window.location.replace(<?php echo json_encode($redirect_url); ?>);</script>
<?php } elseif ($outcome === 'login') { ?>
  <p class="adv-title">Please sign in</p>
  <p>Please <a href="/login/">log in</a> to enter the auctions.</p>
<?php } elseif ($outcome === 'email') { ?>
  <p class="adv-title">We need your account email</p>
  <p>We could not read your account email. Please update your profile and try again, or
     <a href="<?php echo $host_link; ?>">visit Advantage.bid</a>.</p>
<?php } else { ?>
  <p class="adv-title">Sign-in temporarily unavailable</p>
  <p>Please try again shortly, or <a href="<?php echo $host_link; ?>">visit Advantage.bid</a>.</p>
<?php } ?>
</div></div>
