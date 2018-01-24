// tslint:disable no-console no-non-null-assertion max-func-body-length

import * as uuid from 'uuid/v4';
import * as bluebird from 'bluebird';
import { memoize, negate } from 'lodash';
import { connection } from './api/src/database/connection';
import { NotablePerson } from './api/src/database/entities/NotablePerson';
import { EditorialSummaryNode } from './api/src/database/entities/EditorialSummaryNode';
import { EditorialSummary } from './api/src/database/entities/EditorialSummary';
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
      const files = await glob('src/scraper/output/scraperResults/*.json');

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

          const notablePerson = await notablePeople.findOne({ slug });

          if (!notablePerson) {
            throw new TypeError('Expected notable person to exist');
          }

          if (isResultWithContent(json)) {
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
                    child.sourceUrl = sourceUrl ? sourceUrl.trimRight() : null;
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

            notablePerson.editorialSummary = Promise.resolve(editorialSummary);
          }

          return notablePerson;
        },
        { concurrency: 20 },
      );

      await bluebird.map(people, p => notablePeople.save(p), {
        concurrency: 100,
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
