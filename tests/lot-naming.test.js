// WS4 — multi-item lot naming convention (deterministic rule applied to the Smart
// Description model's structured observations). Approved rule:
//   • 4+ substantially similar / matching items → "Set of [Count] …"
//   • 4+ mixed / assorted items                 → "Box Lot of Assorted …"
//   • fewer than 4 items                        → unchanged (rule does not trigger)
//   • an exact count word only when the count is confidently known
//   • never overwrite a title that already follows the convention (seller-entered)
const { composeLotTitle } = require('../src/services/aiDescriptionService');

describe('composeLotTitle — Set of / Box Lot naming', () => {
  test('four matching plates → "Set of Four …"', () => {
    const r = composeLotTitle({ baseTitle: 'Porcelain Dinner Plates', itemCount: 4, itemsSimilar: true, countConfident: true });
    expect(r.title).toBe('Set of Four Porcelain Dinner Plates');
    expect(r.pattern).toBe('set');
    expect(r.applied).toBe(true);
  });

  test('six matching chairs → "Set of Six …"', () => {
    const r = composeLotTitle({ baseTitle: 'Oak Dining Chairs', itemCount: 6, itemsSimilar: true, countConfident: true });
    expect(r.title).toBe('Set of Six Oak Dining Chairs');
    expect(r.pattern).toBe('set');
  });

  test('four assorted kitchen items → "Box Lot of Assorted …"', () => {
    const r = composeLotTitle({ baseTitle: 'Kitchen Utensils', itemCount: 4, itemsSimilar: false, countConfident: true });
    expect(r.title).toBe('Box Lot of Assorted Kitchen Utensils');
    expect(r.pattern).toBe('box_lot');
  });

  test('assorted title already starting with "Assorted" is not doubled', () => {
    const r = composeLotTitle({ baseTitle: 'Assorted Garage Hand Tools', itemCount: 9, itemsSimilar: false, countConfident: false });
    expect(r.title).toBe('Box Lot of Assorted Garage Hand Tools');
  });

  test('mixed group with UNCERTAIN count → Box Lot, never a stated count', () => {
    const r = composeLotTitle({ baseTitle: 'Estate Garage Tools', itemCount: 8, itemsSimilar: false, countConfident: false });
    expect(r.title).toBe('Box Lot of Assorted Estate Garage Tools');
    expect(r.title).not.toMatch(/\b(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|\d)\b/);
  });

  test('similar set with UNCERTAIN count → "Set of …" with no invented number', () => {
    const r = composeLotTitle({ baseTitle: 'Cut Crystal Tumblers', itemCount: 5, itemsSimilar: true, countConfident: false });
    expect(r.title).toBe('Set of Cut Crystal Tumblers');
    expect(r.title).not.toMatch(/Set of (One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve|\d)/);
  });

  test.each([1, 2, 3])('%d item(s) → rule does NOT trigger (title unchanged)', (n) => {
    const r = composeLotTitle({ baseTitle: 'Vintage Brass Table Lamp', itemCount: n, itemsSimilar: true, countConfident: true });
    expect(r.title).toBe('Vintage Brass Table Lamp');
    expect(r.applied).toBe(false);
    expect(r.pattern).toBe('single');
  });

  test('three matching items still do NOT become a set (threshold is 4)', () => {
    const r = composeLotTitle({ baseTitle: 'Nesting Tables', itemCount: 3, itemsSimilar: true, countConfident: true });
    expect(r.title).toBe('Nesting Tables');
    expect(r.applied).toBe(false);
  });

  test('a coherent matching set of four is NOT called a box lot', () => {
    const r = composeLotTitle({ baseTitle: 'Framed Botanical Prints', itemCount: 4, itemsSimilar: true, countConfident: true });
    expect(r.title).toMatch(/^Set of /);
    expect(r.title).not.toMatch(/Box Lot/);
  });

  test('seller-entered title already using the convention is preserved (not doubled)', () => {
    const set = composeLotTitle({ baseTitle: 'Set of 8 Sterling Forks', itemCount: 8, itemsSimilar: true, countConfident: true });
    expect(set.title).toBe('Set of 8 Sterling Forks');
    expect(set.applied).toBe(false);
    expect(set.pattern).toBe('preserved');
    const box = composeLotTitle({ baseTitle: 'Box Lot of Assorted Linens', itemCount: 12, itemsSimilar: false });
    expect(box.title).toBe('Box Lot of Assorted Linens');
    expect(box.applied).toBe(false);
  });

  test('missing / non-numeric count → unchanged', () => {
    expect(composeLotTitle({ baseTitle: 'Walnut Sideboard' }).title).toBe('Walnut Sideboard');
    expect(composeLotTitle({ baseTitle: 'Walnut Sideboard', itemCount: 'lots' }).applied).toBe(false);
  });

  test('large confident matching set uses a numeric word up to twelve, else digits', () => {
    expect(composeLotTitle({ baseTitle: 'Silver Knives', itemCount: 12, itemsSimilar: true, countConfident: true }).title)
      .toBe('Set of Twelve Silver Knives');
    expect(composeLotTitle({ baseTitle: 'Glass Beads', itemCount: 20, itemsSimilar: true, countConfident: true }).title)
      .toBe('Set of 20 Glass Beads');
  });
});

// Catalog-quality refinement: no redundant grouping words, no "Box Lot … Box", and
// no "Set of … Assorted …" contradiction — while every previously-approved natural
// title is unchanged.
describe('composeLotTitle — grouping-word normalization (catalog quality)', () => {
  test('Box Lot: base already "Miscellaneous …" is not doubled with "Assorted"', () => {
    expect(composeLotTitle({ baseTitle: 'Miscellaneous Holiday Decorations', itemCount: 15, itemsSimilar: false, countConfident: false }).title)
      .toBe('Box Lot of Miscellaneous Holiday Decorations');
  });
  test('Box Lot: base already "Mixed …" is not doubled with "Assorted"', () => {
    expect(composeLotTitle({ baseTitle: 'Mixed Office Supplies', itemCount: 10, itemsSimilar: false, countConfident: false }).title)
      .toBe('Box Lot of Mixed Office Supplies');
  });
  test('Box Lot: trailing "Box" is dropped (no "Box Lot … Box")', () => {
    expect(composeLotTitle({ baseTitle: 'Garage Clean-Out Box', itemCount: 25, itemsSimilar: false, countConfident: false }).title)
      .toBe('Box Lot of Assorted Garage Clean-Out');
  });
  test('Box Lot: other grouping synonyms (Various / Sundry) are not doubled', () => {
    expect(composeLotTitle({ baseTitle: 'Various Craft Supplies', itemCount: 12, itemsSimilar: false }).title)
      .toBe('Box Lot of Various Craft Supplies');
    expect(composeLotTitle({ baseTitle: 'Sundry Garden Items', itemCount: 8, itemsSimilar: false }).title)
      .toBe('Box Lot of Sundry Garden Items');
  });

  test('Set: contradictory leading "Assorted" is stripped (Set of Four Plates)', () => {
    expect(composeLotTitle({ baseTitle: 'Assorted Plates', itemCount: 4, itemsSimilar: true, countConfident: true }).title)
      .toBe('Set of Four Plates');
  });
  test('Set: contradictory leading "Mixed" is stripped (Set of Six Glassware)', () => {
    expect(composeLotTitle({ baseTitle: 'Mixed Glassware', itemCount: 6, itemsSimilar: true, countConfident: true }).title)
      .toBe('Set of Six Glassware');
  });

  test('none of the banned awkward outputs can be produced', () => {
    const outputs = [
      composeLotTitle({ baseTitle: 'Miscellaneous Holiday Decorations', itemCount: 15, itemsSimilar: false }).title,
      composeLotTitle({ baseTitle: 'Mixed Office Supplies', itemCount: 10, itemsSimilar: false }).title,
      composeLotTitle({ baseTitle: 'Garage Clean-Out Box', itemCount: 25, itemsSimilar: false }).title,
      composeLotTitle({ baseTitle: 'Assorted Plates', itemCount: 4, itemsSimilar: true, countConfident: true }).title,
      composeLotTitle({ baseTitle: 'Assorted Items', itemCount: 4, itemsSimilar: true, countConfident: true }).title,
    ];
    outputs.forEach((t) => {
      expect(t).not.toMatch(/Assorted\s+(Mixed|Miscellaneous|Misc|Various|Sundry)/i);
      expect(t).not.toMatch(/Box Lot of .*\bBox\b/i);
      expect(t).not.toMatch(/Set of .*\bAssorted\b/i);
    });
  });

  test('previously-approved natural outputs are unchanged', () => {
    expect(composeLotTitle({ baseTitle: 'Porcelain Dinner Plates', itemCount: 4, itemsSimilar: true, countConfident: true }).title)
      .toBe('Set of Four Porcelain Dinner Plates');
    expect(composeLotTitle({ baseTitle: 'Oak Dining Chairs', itemCount: 6, itemsSimilar: true, countConfident: true }).title)
      .toBe('Set of Six Oak Dining Chairs');
    expect(composeLotTitle({ baseTitle: 'Hand Tools', itemCount: 7, itemsSimilar: false }).title)
      .toBe('Box Lot of Assorted Hand Tools');
    expect(composeLotTitle({ baseTitle: 'Kitchen Utensils', itemCount: 6, itemsSimilar: false }).title)
      .toBe('Box Lot of Assorted Kitchen Utensils');
    expect(composeLotTitle({ baseTitle: 'Assorted Hardware', itemCount: 20, itemsSimilar: false }).title)
      .toBe('Box Lot of Assorted Hardware');
    expect(composeLotTitle({ baseTitle: 'Collectibles', itemCount: 5, itemsSimilar: false }).title)
      .toBe('Box Lot of Assorted Collectibles');
    expect(composeLotTitle({ baseTitle: 'Electrical Parts', itemCount: 12, itemsSimilar: false }).title)
      .toBe('Box Lot of Assorted Electrical Parts');
  });
});
