'use strict';

/**
 * seed-showcase-auction.js
 *
 * Creates the Whitfield Estate showcase auction — a live, active auction
 * designed to populate all four marketplace discovery feeds:
 *
 *   Featured Auctions  — auction.marketplace_priority > 0
 *   Ending Soon        — lots with closes_at <= NOW() + 48h, auction.state = 'active'
 *   Trending           — lots with bid_count >= 1, auction.state = 'active'
 *   Just Listed        — lots created within 21 days, auction.state IN ('published','active')
 *
 * Fixed IDs for idempotency — safe to re-run against a live database.
 * Run: node scripts/seed-showcase-auction.js
 */

require('dotenv').config();
const { Pool } = require('pg');

// ---------------------------------------------------------------------------
// Fixed IDs
// ---------------------------------------------------------------------------
const AUCTION_ID  = 'ee000000-0000-4000-8000-000000000001';
const SELLER_ID   = 'e8e94268-10fb-485a-8f2a-82aedde49929'; // test-seller@example.com

// Lot IDs — ee000000-0000-4000-8000-0000000001xx
function lotId(n) {
  return `ee000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function log(msg) { console.log(`[showcase-seed] ${msg}`); }

// ---------------------------------------------------------------------------
// Lot definitions
// ---------------------------------------------------------------------------
// Lots 1–6  → closes_at within 36 hours (Ending Soon eligible)
// Lots 1–5  → bid_count >= 1 (Trending eligible)
// All lots  → state='open', created recently (Just Listed eligible)
// ---------------------------------------------------------------------------

const IMG = {
  rug:        'https://images.unsplash.com/photo-1600585152220-90363fe7e115?w=800&h=600&fit=crop&q=80',
  credenza:   'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&h=600&fit=crop&q=80',
  painting:   'https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=800&h=600&fit=crop&q=80',
  silverware: 'https://images.unsplash.com/photo-1600267185393-e158a98703de?w=800&h=600&fit=crop&q=80',
  crystal:    'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&h=600&fit=crop&q=80',
  vases:      'https://images.unsplash.com/photo-1612532275214-e4ca76d0e4d1?w=800&h=600&fit=crop&q=80',
  desk:       'https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=800&h=600&fit=crop&q=80',
  chairs:     'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&h=600&fit=crop&q=80',
  clock:      'https://images.unsplash.com/photo-1508057198894-247b23fe5ade?w=800&h=600&fit=crop&q=80',
  lamp:       'https://images.unsplash.com/photo-1543159006-2e0c69cfe5b1?w=800&h=600&fit=crop&q=80',
  bookcase:   'https://images.unsplash.com/photo-1507842217343-583bb7270b66?w=800&h=600&fit=crop&q=80',
  botanicals: 'https://images.unsplash.com/photo-1579983096895-a5b76c6a6d9a?w=800&h=600&fit=crop&q=80',
  bronze:     'https://images.unsplash.com/photo-1561970177-f56a78f8cdd1?w=800&h=600&fit=crop&q=80',
  map:        'https://images.unsplash.com/photo-1524661135-423995f22d0b?w=800&h=600&fit=crop&q=80',
  punchbowl:  'https://images.unsplash.com/photo-1519671845926-dc31e66d05f3?w=800&h=600&fit=crop&q=80',
  runner:     'https://images.unsplash.com/photo-1600585153490-76fb20a32601?w=800&h=600&fit=crop&q=80',
  portrait:   'https://images.unsplash.com/photo-1569172122301-bc5008bc09c5?w=800&h=600&fit=crop&q=80',
  camera:     'https://images.unsplash.com/photo-1461360228754-6e81c478b882?w=800&h=600&fit=crop&q=80',
  chest:      'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=800&h=600&fit=crop&q=80',
  books:      'https://images.unsplash.com/photo-1507842217343-583bb7270b66?w=800&h=600&fit=crop&q=80',
  globe:      'https://images.unsplash.com/photo-1524661135-423995f22d0b?w=800&h=600&fit=crop&q=80',
  jewelry:    'https://images.unsplash.com/photo-1535632066927-ab7c9ab60908?w=800&h=600&fit=crop&q=80',
  candlesticks:'https://images.unsplash.com/photo-1578662996442-48f60103fc96?w=800&h=600&fit=crop&q=80',
};

// closes_at relative offsets from NOW()
const SOON   = "NOW() + INTERVAL '32 hours'";   // Ending Soon + Trending
const DAYS5  = "NOW() + INTERVAL '5 days'";
const DAYS6  = "NOW() + INTERVAL '6 days'";
const DAYS7  = "NOW() + INTERVAL '7 days'";
const DAYS8  = "NOW() + INTERVAL '8 days'";

const LOTS = [
  // ── Lots 1-6: Ending Soon (closes within 48h) ─────────────────────────────
  // ── Lots 1-5: also Trending (bid_count >= 1) ──────────────────────────────
  {
    n: 1, title: 'Antique Persian Hand-Knotted Wool Rug, 9\'2" × 12\'4"',
    desc: 'Fine hand-knotted Persian rug in the Tabriz tradition. Rich jewel-tone medallion pattern on a deep ivory field with navy border. All-wool pile and foundation. Minor natural wear consistent with age and use; colors remain vivid. Professionally cleaned.',
    size: 'C', condition: 'Good', material: 'Wool', era: 'Early 20th Century',
    maker: null, starting: 20000, current: 38500, bids: 7,
    closes: SOON, thumb: IMG.rug, featured: true,
  },
  {
    n: 2, title: 'Mid-Century Walnut and Cane Credenza',
    desc: 'Danish-influenced walnut credenza with cane panel doors and tapered brass-tipped legs. Four interior shelves behind two doors, single drawer at center. Clean dovetail joinery. Original finish in very good condition with minor surface patina.',
    size: 'C', condition: 'Very Good', material: 'Walnut, Cane, Brass', era: '1950s–1960s',
    maker: null, starting: 15000, current: 24000, bids: 5,
    closes: SOON, thumb: IMG.credenza, featured: true,
  },
  {
    n: 3, title: 'American School Oil Painting: Harbor Scene at Dusk',
    desc: 'Oil on canvas, unsigned. Depicts a calm harbor at last light — fishing vessels at rest, amber reflections on still water, distant tree line. Original gilt frame, minor flaking to lower left corner. Canvas sound. 24" × 36" image, 30" × 42" framed.',
    size: 'B', condition: 'Good', material: 'Oil on Canvas', era: 'Late 19th Century',
    maker: 'American School', starting: 8000, current: 12500, bids: 4,
    closes: SOON, thumb: IMG.painting, featured: true,
  },
  {
    n: 4, title: 'Sterling Silver Tea and Coffee Service, 5-Piece',
    desc: 'American sterling silver tea and coffee service comprising: coffee pot, teapot, creamer, sugar bowl with cover, and waste bowl. Repousse floral decoration with engraved monogram "W" to each piece. Marked: Sterling. Combined weight approximately 72 troy oz.',
    size: 'B', condition: 'Very Good', material: 'Sterling Silver', era: 'Late 19th–Early 20th Century',
    maker: null, starting: 35000, current: 52000, bids: 9,
    closes: SOON, thumb: IMG.silverware, featured: true,
  },
  {
    n: 5, title: 'Set of Six Cut Crystal Whisky Tumblers with Decanter',
    desc: 'Brilliant lead crystal decanter and six matching tumblers in the thistle-cut pattern. Stoppered decanter, 11" tall. Tumblers 4" each. No chips or cracks. Exceptional prismatic clarity. Possibly Waterford or comparable Continental maker.',
    size: 'A', condition: 'Excellent', material: 'Lead Crystal', era: 'Mid 20th Century',
    maker: null, starting: 6000, current: 8500, bids: 3,
    closes: SOON, thumb: IMG.crystal, featured: false,
  },
  {
    n: 6, title: 'Pair of Chinese Export Famille Rose Porcelain Vases',
    desc: 'Matched pair of Chinese export porcelain vases with famille rose decoration — polychrome floral sprays on white ground with gilt accent borders. 14" tall. Republic period or earlier. Hairline crack to base of one vase, not visible when displayed.',
    size: 'A', condition: 'Good', material: 'Porcelain', era: 'Early 20th Century',
    maker: null, starting: 10000, current: 10000, bids: 0,
    closes: SOON, thumb: IMG.vases, featured: false,
  },
  // ── Lots 7–32: Close in 5–8 days ──────────────────────────────────────────
  {
    n: 7, title: 'Rosewood Writing Desk with Green Leather Top',
    desc: 'English Regency-style rosewood pedestal desk. Green tooled leather writing surface with gilt-rule border. Three drawers to pedestals, single drawer to center. Fitted interior with pigeonholes and small drawers. Original brass pulls. 54" wide.',
    size: 'C', condition: 'Good', material: 'Rosewood, Leather', era: 'Early 19th Century',
    maker: null, starting: 25000, current: 25000, bids: 0,
    closes: DAYS5, thumb: IMG.desk, featured: false,
  },
  {
    n: 8, title: 'Pair of Chippendale-Style Mahogany Side Chairs',
    desc: 'Matched pair of carved mahogany side chairs in the Chippendale manner. Pierced vase-shaped splats, cabriole legs terminating in ball-and-claw feet. Upholstered seats in worn needlepoint, structurally sound. American, 18th or early 19th century.',
    size: 'B', condition: 'Good', material: 'Mahogany', era: '18th–Early 19th Century',
    maker: null, starting: 12000, current: 12000, bids: 0,
    closes: DAYS5, thumb: IMG.chairs, featured: false,
  },
  {
    n: 9, title: 'Art Deco Marble and Gilt Bronze Mantel Clock',
    desc: 'French Art Deco mantel clock with black Belgian marble case and gilt bronze mounts. Eight-day movement, strikes on the half hour. Pendulum and key present. Runs and strikes correctly. 14" tall × 10" wide. Minor marble edge chip to rear base.',
    size: 'A', condition: 'Very Good', material: 'Marble, Gilt Bronze, Brass', era: '1920s–1930s',
    maker: null, starting: 9000, current: 9000, bids: 0,
    closes: DAYS5, thumb: IMG.clock, featured: false,
  },
  {
    n: 10, title: 'Vintage Brass Adjustable Floor Lamp',
    desc: 'Mid-century adjustable floor lamp with heavy brass base and telescoping brass pole. Original dome shade in olive green enamel. Three-way socket, newly rewired with period-appropriate cloth cord. 58" tall at maximum extension.',
    size: 'B', condition: 'Very Good', material: 'Brass, Enamel', era: '1950s–1960s',
    maker: null, starting: 4500, current: 4500, bids: 0,
    closes: DAYS5, thumb: IMG.lamp, featured: false,
  },
  {
    n: 11, title: 'Victorian Mahogany Bookcase, Three-Section Breakfront',
    desc: 'Large Victorian breakfront bookcase in figured mahogany. Glazed upper doors with Gothic-arch tracery, solid lower cupboards. Adjustable shelves. Original brass fittings. 86" tall × 72" wide × 18" deep. Disassembles into three sections for moving.',
    size: 'C', condition: 'Good', material: 'Mahogany, Brass', era: 'Victorian (1860–1890)',
    maker: null, starting: 18000, current: 18000, bids: 0,
    closes: DAYS5, thumb: IMG.bookcase, featured: false,
  },
  {
    n: 12, title: 'Pair of Ceramic Table Lamps with Matching Shades',
    desc: 'Matched pair of celadon-glazed ceramic urn lamps on ebonized wood bases. Original ivory silk drum shades with black trim. 26" tall to top of shade finial. Wiring in good order. Small glaze chip to base of one lamp, not visible when assembled.',
    size: 'A', condition: 'Good', material: 'Ceramic, Wood, Silk', era: 'Mid 20th Century',
    maker: null, starting: 5000, current: 5000, bids: 0,
    closes: DAYS5, thumb: IMG.lamp, featured: false,
  },
  {
    n: 13, title: 'Set of Four Framed Botanical Watercolors',
    desc: 'Four original watercolor studies of garden botanicals — roses, peonies, foxglove, and lily of the valley. Signed lower right in pencil, indistinct. Uniformly framed in gilt molding, original matting. Each image approximately 9" × 12". Clean and unfaded.',
    size: 'A', condition: 'Very Good', material: 'Watercolor on Paper', era: 'Early 20th Century',
    maker: null, starting: 3500, current: 3500, bids: 0,
    closes: DAYS6, thumb: IMG.botanicals, featured: false,
  },
  {
    n: 14, title: 'Antique Copper Samovar with Original Stand',
    desc: 'Russian samovar in polished copper with original brass spigot and stand. Coal-burning style, converted for display. All components present including original tray, chimney, and ring handles. 24" tall assembled. Minor denting to lid.',
    size: 'B', condition: 'Good', material: 'Copper, Brass', era: 'Late 19th Century',
    maker: null, starting: 6000, current: 6000, bids: 0,
    closes: DAYS6, thumb: IMG.silverware, featured: false,
  },
  {
    n: 15, title: 'Bronze Figure of a Discus Thrower on Marble Base',
    desc: 'Cast bronze sculpture after the classical Discobolus. Heavy lost-wax casting with warm brown patina. Mounted on a rectangular black marble plinth with gilt-plate nameplate. 18" tall including base. Minor surface oxidation to underside, not visible when displayed.',
    size: 'B', condition: 'Very Good', material: 'Bronze, Marble', era: 'Late 19th–Early 20th Century',
    maker: null, starting: 14000, current: 14000, bids: 0,
    closes: DAYS6, thumb: IMG.bronze, featured: true,
  },
  {
    n: 16, title: 'Set of 12 Sterling Silver Dinner Knives with Monogram',
    desc: 'Twelve sterling silver-handled dinner knives with stainless steel blades. Engraved "W" monogram to each handle. Reeded border pattern. Original baize-lined canteen box, worn but functional. Combined handle weight approximately 18 troy oz.',
    size: 'A', condition: 'Very Good', material: 'Sterling Silver, Stainless Steel', era: 'Early 20th Century',
    maker: null, starting: 8000, current: 8000, bids: 0,
    closes: DAYS6, thumb: IMG.silverware, featured: false,
  },
  {
    n: 17, title: 'Arts and Crafts Movement Side Table, Oak',
    desc: 'Quartersawn white oak side table in the Arts and Crafts tradition. Square tapered legs with through-tenon construction, lower shelf, and single drawer with hammered copper pull. Original finish with warm amber patina. 28" tall × 20" square top.',
    size: 'B', condition: 'Very Good', material: 'Quartersawn Oak, Copper', era: '1900–1920',
    maker: null, starting: 4500, current: 4500, bids: 0,
    closes: DAYS6, thumb: IMG.desk, featured: false,
  },
  {
    n: 18, title: 'Framed Map: State of Illinois, 1876 Centennial Edition',
    desc: 'Chromolithograph map of the State of Illinois, published for the U.S. Centennial, 1876. County boundaries shown in four colors, decorative cartouche with state seal. Original frame and mat with some foxing to margins. Image 18" × 24". Period document.',
    size: 'A', condition: 'Good', material: 'Chromolithograph on Paper', era: '1876',
    maker: null, starting: 2500, current: 2500, bids: 0,
    closes: DAYS6, thumb: IMG.map, featured: false,
  },
  {
    n: 19, title: 'Pair of French Empire–Style Silver Plate Candlestick Holders',
    desc: 'Matched pair of substantial silver plate candlestick holders in the Empire style. Columnar form with acanthus decoration, stepped square bases. 12" tall. Sheffield plate or later electroplate — unmarked. Even patina, no significant wear through.',
    size: 'A', condition: 'Good', material: 'Silver Plate', era: 'Early 20th Century',
    maker: null, starting: 3000, current: 3000, bids: 0,
    closes: DAYS6, thumb: IMG.candlesticks, featured: false,
  },
  {
    n: 20, title: 'Cut Crystal Punch Bowl Set with 12 Cups and Ladle',
    desc: 'American brilliant-cut lead crystal punch bowl, 14" diameter × 9" tall, with twelve 4" cups and matching silver plate ladle. Hobstar-and-fan pattern. No chips, no cracks. Exceptional weight and brilliance. Complete set, rarely offered intact.',
    size: 'B', condition: 'Excellent', material: 'Lead Crystal, Silver Plate', era: 'Early 20th Century',
    maker: null, starting: 12000, current: 12000, bids: 0,
    closes: DAYS7, thumb: IMG.punchbowl, featured: false,
  },
  {
    n: 21, title: 'Antique Kilim Flat-Weave Wool Runner, 3\'3" × 11\'6"',
    desc: 'Anatolian kilim runner in geometric tribal pattern. Brick red, ivory, and indigo on a camel ground. All-wool, flat-woven construction. Some restoration to one end fringe; pile flat-weave is sound throughout. Suitable for hallway or under a console.',
    size: 'C', condition: 'Good', material: 'Wool', era: 'Early 20th Century',
    maker: null, starting: 5500, current: 5500, bids: 0,
    closes: DAYS7, thumb: IMG.runner, featured: false,
  },
  {
    n: 22, title: 'Victorian Oval Portrait in Gilded Frame',
    desc: 'Oil on canvas oval portrait of a young woman in half-length, wearing a white dress with lace collar. Unsigned. Original carved and gilded oval frame with some losses to gilding at edges. 20" × 16" image, 28" × 24" framed overall. Canvas and paint sound.',
    size: 'B', condition: 'Good', material: 'Oil on Canvas', era: 'Victorian (1870–1890)',
    maker: null, starting: 4500, current: 4500, bids: 0,
    closes: DAYS7, thumb: IMG.portrait, featured: false,
  },
  {
    n: 23, title: 'Leica-Style 35mm Rangefinder Camera with Leather Case',
    desc: 'German 35mm rangefinder camera in the Leica M-type tradition. Elmar 50mm f/3.5 collapsible lens. Shutter fires on all speeds. Rangefinder patch bright and accurate. Original tan leather ever-ready case with strap, showing natural wear. Functional collector piece.',
    size: 'A', condition: 'Very Good', material: 'Brass, Glass, Leather', era: '1950s–1960s',
    maker: 'German', starting: 8500, current: 8500, bids: 0,
    closes: DAYS7, thumb: IMG.camera, featured: false,
  },
  {
    n: 24, title: 'Early American Pine Blanket Chest, c.1840',
    desc: 'Six-board pine blanket chest in original red-painted surface. Cut nail construction, hand-forged iron strap hinges, simple till interior. Some wear and minor losses to paint consistent with age and use. 48" wide × 20" deep × 22" tall. Solid and functional.',
    size: 'C', condition: 'Good', material: 'Pine, Iron', era: 'c.1840',
    maker: null, starting: 6500, current: 6500, bids: 0,
    closes: DAYS7, thumb: IMG.chest, featured: false,
  },
  {
    n: 25, title: 'Collection of First Edition American Fiction, 12 Volumes',
    desc: 'Twelve first edition novels from the American literary canon, 1920s–1950s. Titles include authors such as Hemingway, Fitzgerald, and Steinbeck — full list in auction description. Mixed condition, several with dust jackets. Sold as a collection, not separated.',
    size: 'A', condition: 'Mixed', material: 'Cloth and Paper', era: '1920s–1950s',
    maker: null, starting: 15000, current: 15000, bids: 0,
    closes: DAYS7, thumb: IMG.books, featured: false,
  },
  {
    n: 26, title: 'Pair of Carved Wooden Ceremonial Masks',
    desc: 'Two carved hardwood ceremonial masks from West Africa, likely Yoruba or Fon tradition. Pigment decoration retained in recesses. One with metal accoutrements to headdress. Collected mid-20th century. Each approximately 12"–16" tall. Provenance documentation available.',
    size: 'A', condition: 'Very Good', material: 'Hardwood, Pigment, Metal', era: 'Early–Mid 20th Century',
    maker: null, starting: 7000, current: 7000, bids: 0,
    closes: DAYS7, thumb: IMG.bronze, featured: false,
  },
  {
    n: 27, title: 'Antique Globe on Mahogany Stand, c.1910',
    desc: 'Terrestrial table globe, 12" diameter, mounted in a turned mahogany meridian ring on four-footed stand. Chromolithograph paper gores on plaster sphere. Political boundaries reflect circa 1905–1915 geopolitical configuration. Some browning and foxing to paper; colors retained.',
    size: 'B', condition: 'Good', material: 'Paper, Plaster, Mahogany', era: 'c.1910',
    maker: null, starting: 9500, current: 9500, bids: 0,
    closes: DAYS8, thumb: IMG.globe, featured: false,
  },
  {
    n: 28, title: 'Silk Damask Throw Pillows, Set of 6',
    desc: 'Six matched throw pillows in antique ivory silk damask with gold brocade medallion pattern and tassel trim. Approximately 18" square each. Feather-down inserts. Minor surface soiling to two pillows, professional cleaning recommended. Period fabric, excellent condition overall.',
    size: 'A', condition: 'Good', material: 'Silk, Down', era: 'Early–Mid 20th Century',
    maker: null, starting: 2500, current: 2500, bids: 0,
    closes: DAYS8, thumb: IMG.rug, featured: false,
  },
  {
    n: 29, title: 'Brass and Enamel Art Nouveau Jewelry Box',
    desc: 'Small Art Nouveau jewelry casket in patinated brass with cloisonné enamel lid panel depicting iris flowers in violet and green on a cobalt ground. Silk-lined interior with removable tray. Hinges and clasp functional. 6" wide × 4" deep × 3" tall.',
    size: 'A', condition: 'Very Good', material: 'Brass, Enamel, Silk', era: '1895–1910',
    maker: null, starting: 4000, current: 4000, bids: 0,
    closes: DAYS8, thumb: IMG.jewelry, featured: false,
  },
  {
    n: 30, title: 'Needlepoint Fireplace Screen in Carved Walnut Frame',
    desc: 'Victorian needlepoint fireplace screen depicting a formal garden scene with peacock on a terrace. Worked in fine tent stitch on canvas in excellent condition — vivid colors, no fading. Carved and ebonized walnut frame with brass feet. Screen 34" tall × 28" wide.',
    size: 'B', condition: 'Very Good', material: 'Wool Needlepoint, Walnut, Brass', era: 'Victorian',
    maker: null, starting: 3500, current: 3500, bids: 0,
    closes: DAYS8, thumb: IMG.portrait, featured: false,
  },
  {
    n: 31, title: 'Set of 8 Sterling Silver Demitasse Spoons in Presentation Case',
    desc: 'Eight sterling silver demitasse spoons in the Lily of the Valley pattern. Engraved "W" to each handle bowl. Original fitted presentation case with cream velvet and satin lining. Each spoon approximately 4.5" long. Marked: Sterling. Combined weight approximately 3 troy oz.',
    size: 'A', condition: 'Excellent', material: 'Sterling Silver', era: 'Early 20th Century',
    maker: null, starting: 2000, current: 2000, bids: 0,
    closes: DAYS8, thumb: IMG.silverware, featured: false,
  },
  {
    n: 32, title: 'Pair of Waterford Crystal Candlesticks',
    desc: 'Matched pair of Waterford Crystal candlesticks in the Lismore pattern. 7" tall. Signed "Waterford" on base. No chips or cracks. Original box present for one candlestick. Exceptional lead crystal clarity and weight.',
    size: 'A', condition: 'Excellent', material: 'Lead Crystal', era: 'Late 20th Century',
    maker: 'Waterford', starting: 4500, current: 4500, bids: 0,
    closes: DAYS8, thumb: IMG.crystal, featured: false,
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    log('Connecting to database...');
    await pool.query('SELECT 1');
    log('Database connection OK');

    // -----------------------------------------------------------------------
    // 1. Upsert auction
    // -----------------------------------------------------------------------
    await pool.query(`
      INSERT INTO auctions (
        id, seller_id, title, subtitle, description,
        state, marketplace_priority,
        city, address_state, zip,
        public_auction_type,
        cover_image_url, banner_image_url,
        start_time, end_time,
        pickup_window_start, pickup_window_end
      )
      VALUES (
        $1, $2,
        'The Whitfield Estate — Evanston, Illinois',
        'Four generations of fine furnishings, art, silver, and decorative objects',
        $3,
        'active', 10,
        'Evanston', 'IL', '60201',
        'Estate Liquidation',
        $4, $4,
        NOW() - INTERVAL '2 days',
        NOW() + INTERVAL '8 days',
        NOW() + INTERVAL '9 days',
        NOW() + INTERVAL '11 days'
      )
      ON CONFLICT (id) DO NOTHING
    `, [
      AUCTION_ID,
      SELLER_ID,
      'A curated estate auction featuring four generations of furnishings, fine art, sterling silver, ' +
      'porcelain, rugs, and decorative objects from a distinguished Evanston residence. ' +
      'All pieces have been inventoried, condition-noted, and photographed in situ. ' +
      'Preview available by appointment. Pickup at the estate address after auction close.',
      IMG.rug,
    ]);
    log('Auction upserted (or already existed)');

    // -----------------------------------------------------------------------
    // 2. Update seller_profile display fields (idempotent UPDATE, no-op if
    //    display_name is already set so we don't overwrite manual edits)
    // -----------------------------------------------------------------------
    await pool.query(`
      UPDATE seller_profiles
         SET display_name   = COALESCE(display_name,   'Advantage Estate Services'),
             location_label = COALESCE(location_label, 'Evanston, IL')
       WHERE id = $1
    `, [SELLER_ID]);
    log('Seller profile display fields updated');

    // -----------------------------------------------------------------------
    // 3. Insert lots
    // -----------------------------------------------------------------------
    let inserted = 0;
    let skipped  = 0;

    for (const lot of LOTS) {
      const id = lotId(lot.n);

      const result = await pool.query(`
        INSERT INTO lots (
          id, auction_id, lot_number, title, description,
          state, size_category, condition, material, era, maker_artist,
          starting_bid_cents, current_bid_cents, bid_count,
          closes_at, is_featured, thumbnail_url, images_count,
          shippable
        )
        VALUES (
          $1, $2, $3, $4, $5,
          'open', $6, $7, $8, $9, $10,
          $11, $12, $13,
          ${lot.closes}, $14, $15, 1,
          false
        )
        ON CONFLICT (id) DO NOTHING
      `, [
        id, AUCTION_ID, lot.n, lot.title, lot.desc,
        lot.size, lot.condition, lot.material, lot.era, lot.maker || null,
        lot.starting, lot.current, lot.bids,
        lot.featured, lot.thumb,
      ]);

      if (result.rowCount > 0) {
        inserted++;
        log(`  Lot ${lot.n}: ${lot.title.substring(0, 50)}... [inserted]`);
      } else {
        skipped++;
        log(`  Lot ${lot.n}: already exists [skipped]`);
      }
    }

    log(`\nLots: ${inserted} inserted, ${skipped} already existed`);
    log('\nShowcase auction seeding complete.');
    log(`Auction ID: ${AUCTION_ID}`);
    log('');
    log('Verify with:');
    log('  curl "https://advantage-auction-platform-production.up.railway.app/api/public/featured-auctions?limit=5"');
    log('  curl "https://advantage-auction-platform-production.up.railway.app/api/public/lots/ending-soon?limit=6"');
    log('  curl "https://advantage-auction-platform-production.up.railway.app/api/public/lots/trending?limit=5"');
    log('  curl "https://advantage-auction-platform-production.up.railway.app/api/public/lots/recently-added?limit=6"');

  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('[showcase-seed] FATAL:', err.message);
  process.exit(1);
});
