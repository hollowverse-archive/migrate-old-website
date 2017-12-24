// tslint:disable no-console no-non-null-assertion max-func-body-length

import * as uuid from 'uuid/v4';
import * as path from 'path';
import * as bluebird from 'bluebird';
import { compact, memoize, negate } from 'lodash';
import { connection } from './api/src/database/connection';
import { NotablePerson } from './api/src/database/entities/NotablePerson';
import { EditorialSummaryNode } from './api/src/database/entities/EditorialSummaryNode';
import { EditorialSummary } from './api/src/database/entities/EditorialSummary';
import { NotablePersonLabel } from './api/src/database/entities/NotablePersonLabel';
import { readJson } from './api/src/helpers/readFile';
import {
  Result,
  isResultWithContent,
  isBlockPiece,
  isInlinePiece,
  hasParent,
} from './scraper/src/lib/scrape';
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
            const { religion, politicalViews } = json;

            const summary: string[] = compact([religion, politicalViews]);

            notablePerson.summary =
              summary.length > 0 ? summary.join('\n') : null;

            const idToUuid = memoize(_ => uuid());

            const getChildren = (node: EditorialSummaryNode) => {
              return json.content
                .filter(child => {
                  return (
                    hasParent(child) && idToUuid(child.parentId) === node.id
                  );
                })
                .map((_child, i) => {
                  const child = new EditorialSummaryNode();
                  child.parent = node;
                  child.order = i;
                  child.type = _child.type;
                  child.editorialSummary = node.editorialSummary;
                  if (isInlinePiece(_child)) {
                    child.id = uuid();
                    const { sourceTitle, sourceUrl, text } = _child;
                    child.sourceTitle = sourceTitle || null;
                    child.sourceUrl = sourceUrl || null;
                    child.text = text || null;
                    child.children = [];
                  } else {
                    child.id = idToUuid(_child.id);
                    child.children = getChildren(child);
                  }

                  return child;
                });
            };

            const editorialSummary = new EditorialSummary();
            editorialSummary.author = json.author;
            editorialSummary.lastUpdatedOn = json.lastUpdatedOn
              ? new Date(json.lastUpdatedOn)
              : null;

            editorialSummary.nodes = json.content
              .filter(isBlockPiece)
              .filter(negate(hasParent))
              .map((_node, i) => {
                const node = new EditorialSummaryNode();
                node.editorialSummary = editorialSummary;
                node.type = _node.type;
                node.order = i;
                node.id = idToUuid(_node.id);
                node.children = getChildren(node);
                node.parent = null;

                return node;
              });

            notablePerson.editorialSummary = editorialSummary;
          }

          return notablePerson;
        },
        { concurrency: 20 },
      );

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
