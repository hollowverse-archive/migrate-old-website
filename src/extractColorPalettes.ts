// tslint:disable no-console no-non-null-assertion max-func-body-length

import * as path from 'path';
import * as bluebird from 'bluebird';
import { glob, readFile, writeFile } from './scraper/src/lib/helpers';
import { getColorPalette } from './api/src/helpers/getColorPalette';
import { keyBy, mapValues, camelCase, mapKeys } from 'lodash';

(async () => {
  try {
    const files = await glob('src/scraper/output/images/*');
    const results = mapValues(
      keyBy(
        await bluebird.map(
          files,
          async file => {
            const buffer = await readFile(file);

            return {
              name: path.basename(file),
              palette: await getColorPalette(buffer),
            };
          },
          { concurrency: 20 },
        ),
        r => r.name,
      ),
      v => mapKeys(v.palette, (_, k) => camelCase(k)),
    );

    await writeFile(
      'src/api/data/palettes.json',
      JSON.stringify(results, undefined, 2),
    );

    console.info('Color palettes extracted successfully');
    process.exit(0);
  } catch (e) {
    console.error('Error extracting color palettes:', e);
    process.exit(1);
  }
})();
