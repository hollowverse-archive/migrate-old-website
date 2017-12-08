// tslint:disable no-console no-non-null-assertion max-func-body-length

import * as uuid from 'uuid/v4';
import * as path from 'path';
import * as bluebird from 'bluebird';
import { compact } from 'lodash';
import { connection } from './api/src/database/connection';
import { NotablePerson } from './api/src/database/entities/notablePerson';
import { EditorialSummaryNode } from './api/src/database/entities/editorialSummaryNode';
import { NotablePersonLabel } from './api/src/database/entities/notablePersonLabel';
import { readJson } from './api/src/helpers/readFile';
import { Result, isPiece, isResultWithContent } from './scraper/src/lib/scrape';
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

      const people = await bluebird.map(files, async file => {
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
          (await notablePeople.findOne({ where: { slug } })) ||
          new NotablePerson();
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

        if (isResultWithContent(json)) {
          const { religion, politicalViews } = json;

          const summary: string[] = compact([religion, politicalViews]);

          notablePerson.summary =
            summary.length > 0 ? summary.join('\n') : null;

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

          notablePerson.editorialSummaryAuthor = json.author;

          notablePerson.editorialSummaryNodes = json.content.map(
            (_node, order) => {
              const node = new EditorialSummaryNode();
              node.notablePerson = notablePerson;
              node.type = _node.type;
              node.id = uuid();
              node.order = order;
              if (isPiece(_node)) {
                const { sourceTitle, sourceUrl, text } = _node;
                node.sourceTitle = sourceTitle || null;
                node.sourceUrl = sourceUrl || null;
                node.text = text || null;
              }

              return node;
            },
          );
        }

        return notablePerson;
      });

      const labels = Array.from(labelsToSave.values());
      await notablePersonLabels.save(labels);
      await notablePeople.save(people);
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
