export default function Home() {
  return (
    <main style={{ padding: "40px", fontFamily: "Arial" }}>
      <h1>Advantage Auction Platform</h1>
      <p>Search, bid, and win premium auctions.</p>

      <div style={{ marginTop: "20px" }}>
        <a href="/auctions">
          <button style={{ padding: "10px 20px", cursor: "pointer" }}>
            View Auctions
          </button>
        </a>
      </div>
    </main>
  );
}
