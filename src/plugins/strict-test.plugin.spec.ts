import {
  StrictTestPlugin,
  STRICT_REJECTED_CATEGORY,
} from './strict-test.plugin';

describe('StrictTestPlugin', () => {
  it('exposes the strict trigger category so it survives boundary validation', () => {
    const plugin = new StrictTestPlugin();
    expect(plugin.getCategories().map((c) => c.key)).toContain(
      STRICT_REJECTED_CATEGORY,
    );
  });
});
