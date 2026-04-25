const SAMPLES = [
  {
    title:       'Vintage Brass Table Lamp with Fabric Shade',
    description: 'A vintage brass table lamp featuring a tapered base and original fabric shade. Shows light wear consistent with age. Tested and functional at time of cataloging.',
    category:    'Home Decor'
  },
  {
    title:       'Solid Oak Roll-Top Desk',
    description: 'A solid oak roll-top desk with tambour closure, fitted interior with pigeonholes and small drawers. Some surface scratching to the writing area. Hardware appears original.',
    category:    'Furniture'
  },
  {
    title:       'Oil on Canvas Landscape Painting, Unsigned',
    description: 'An oil on canvas landscape depicting a rural field scene. Housed in a gilt wood frame with minor losses to molding. Canvas shows light craquelure. Unsigned.',
    category:    'Fine Art'
  },
  {
    title:       'Sterling Silver Charm Bracelet with Assorted Charms',
    description: 'A sterling silver link bracelet with twelve assorted charms including travel motifs and animals. Marked 925. Clasp functions correctly. Light surface wear throughout.',
    category:    'Jewelry'
  },
  {
    title:       'Cast Iron Hand Plane, Stanley No. 4',
    description: 'A cast iron bench hand plane with intact blade and adjustment mechanism. Tote and knob are intact with minor chips. Blade shows prior sharpening. Ready for use or display.',
    category:    'Tools'
  },
  {
    title:       'Ceramic Stoneware Crock with Lid',
    description: 'A salt-glazed stoneware crock with fitted lid and applied handles. Blue cobalt floral decoration to front. Small hairline to base, does not affect structural integrity.',
    category:    'Pottery & Ceramics'
  },
  {
    title:       'Mahogany Claw-Foot Side Table',
    description: 'A mahogany side table with single drawer and claw-and-ball feet. Drawer operates smoothly with original brass pull. Surface shows light ring marks and patina consistent with age.',
    category:    'Furniture'
  },
  {
    title:       'Gilt Bronze Mantel Clock',
    description: 'A gilt bronze mantel clock with enamel dial and roman numerals. Movement not tested. Glass bezel intact. Minor tarnishing to gilt surfaces. Key not included.',
    category:    'Clocks & Timepieces'
  },
  {
    title:       'Watercolor on Paper, Coastal Scene',
    description: 'A watercolor on paper depicting a coastal harbor scene with boats. Matted and framed under glass. Some light foxing to margins outside the mat. Unsigned lower right.',
    category:    'Fine Art'
  },
  {
    title:       'Vintage Leather-Top Writing Box',
    description: 'A Victorian-era leather-topped writing box with hinged lid opening to a fitted interior with inkwell compartment. Brass fittings show patina. Leather surface with light cracking.',
    category:    'Antiques'
  }
];

const PICKUP_CATEGORY = {
  'Furniture':            'C',
  'Fine Art':             'C',
  'Clocks & Timepieces':  'B',
  'Home Decor':           'B',
  'Tools':                'B',
  'Pottery & Ceramics':   'B',
  'Antiques':             'B',
  'Jewelry':              'A',
};

const CONDITION_NOTES = [
  'No issues noted beyond normal age-related wear.',
  'Sold as-is. Condition consistent with stated age.',
  'Surface wear noted; no structural damage observed.',
  'Appears complete. Not tested beyond visual inspection.',
  'Minor blemishes consistent with use and storage.'
];

async function generateDescriptionFromImage(imageUrl) {
  console.log('[ai] generating description for image:', imageUrl);

  const sample = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];
  const note   = CONDITION_NOTES[Math.floor(Math.random() * CONDITION_NOTES.length)];

  return {
    title:            sample.title,
    description:      `${sample.description} ${note}`,
    category:         sample.category,
    pickup_category:  PICKUP_CATEGORY[sample.category] || 'B'
  };
}

module.exports = { generateDescriptionFromImage };
