// tslint:disable no-console no-non-null-assertion max-func-body-length

import * as path from 'path';
import * as bluebird from 'bluebird';
import { connection } from './api/src/database/connection';
import { NotablePerson } from './api/src/database/entities/NotablePerson';
import { readJson } from './api/src/helpers/readFile';
import { Result } from './scraper/src/lib/scrape';
import { WikipediaData } from './scraper/src/lib/getWikipediaInfo';
import { glob } from './scraper/src/lib/helpers';

type ScraperResult = Result & {
  wikipediaData?: WikipediaData;
};

connection
  .then(async db =>
    db.transaction(async entityManager => {
      const notablePeople = entityManager.getRepository(NotablePerson);
      const files = await glob('src/scraper/output/scraperResults/*.json');

      await bluebird.each(files, async file => {
        const json = await readJson<ScraperResult>(file);

        if (json.wikipediaData === undefined) {
          throw new TypeError('Expected object to have Wikipedia data.');
        }

        const oldSlug = path.basename(file).replace('.json', '');

        const c = await notablePeople.findOne({ oldSlug });
        if (c) {
          c.relatedPeople = await bluebird
            .map(json.relatedPeople, p => {
              const related = notablePeople.findOne({ oldSlug: p.slug });
              if (related) {
                return related;
              }
              throw new Error(
                `Could not find related notable person ${p.slug}`,
              );
            })
            .filter(Boolean);

          await notablePeople.save(c);
        } else {
          console.warn('Could not find notable person', oldSlug);
        }
      });
    }),
  )
  .then(() => {
    console.info('Scraper data imported successfully');
    process.exit(0);
  })
  .catch(e => {
    console.error('Error importing data:', e);
    process.exit(1);
  });

process.on('unhandledRejection', e => {
  console.error(e);
  process.exit(1);
});
