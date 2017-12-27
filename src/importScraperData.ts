// tslint:disable no-console no-non-null-assertion max-func-body-length

import * as uuid from 'uuid/v4';
import * as path from 'path';
import * as bluebird from 'bluebird';
import { compact } from 'lodash';
import { connection } from './api/src/database/connection';
import { NotablePerson } from './api/src/database/entities/NotablePerson';
import { NotablePersonLabel } from './api/src/database/entities/NotablePersonLabel';
import { readJson } from './api/src/helpers/readFile';
import { Result, isResultWithContent } from './scraper/src/lib/scrape';
import { WikipediaData } from './scraper/src/lib/getWikipediaInfo';
import { glob } from './scraper/src/lib/helpers';

type ScraperResult = Result & {
  wikipediaData?: WikipediaData;
};

connection
  .then(async db =>
    db.transaction(async entityManager => {
      const notablePeople = entityManager.getRepository(NotablePerson);
      const notablePersonLabels = entityManager.getRepository(
        NotablePersonLabel,
      );
      const files = await glob('src/scraper/output/scraperResults/*.json');
      const labelsToSave = new Map<string, NotablePersonLabel>();

      const people = await bluebird.map(
        files,
        async file => {
          const json = await readJson<ScraperResult>(file);

          if (json.wikipediaData === undefined) {
            throw new TypeError('Expected object to have Wikipedia data.');
          }

          const slug = decodeURI(json.wikipediaData.url).replace(
            'https://en.wikipedia.org/wiki/',
            '',
          );
          const oldSlug = path.basename(file).replace('.json', '');

          const notablePerson =
            (await notablePeople.findOne({ slug })) || new NotablePerson();

          notablePerson.id = notablePerson.id || uuid();

          notablePerson.name = json.wikipediaData.title;
          notablePerson.slug = slug;
          notablePerson.oldSlug = oldSlug;
          const matchingPhotos = await glob(`${slug}.*`, {
            cwd: 'src/scraper/output/images',
            matchBase: false,
          });

          notablePerson.photoId =
            matchingPhotos.length > 0 ? matchingPhotos[0] : null;

          notablePerson.labels = await bluebird.map(json.tags, async tag => {
            const text = tag.toLowerCase();
            const saved =
              (await notablePersonLabels.findOne({ text })) ||
              labelsToSave.get(text);

            if (saved) {
              return saved;
            }

            const label = new NotablePersonLabel();
            label.id = uuid();
            label.createdAt = new Date();
            label.text = text;

            labelsToSave.set(text, label);

            return label;
          });

          if (isResultWithContent(json)) {
            const { religion, politicalViews, lastUpdatedOn } = json;

            notablePerson.addedOn = lastUpdatedOn
              ? new Date(lastUpdatedOn)
              : null;

            const summary: string[] = compact([religion, politicalViews]);

            notablePerson.summary =
              summary.length > 0 ? summary.join('\n') : null;
          }

          return notablePerson;
        },
        { concurrency: 20 },
      );

      const labels = Array.from(labelsToSave.values());
      await notablePersonLabels.save(labels);
      await bluebird.map(people, p => notablePeople.save(p), {
        concurrency: 20,
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
