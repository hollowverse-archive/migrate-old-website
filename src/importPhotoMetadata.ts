// tslint:disable no-console no-non-null-assertion max-func-body-length

import * as path from 'path';
import * as bluebird from 'bluebird';
import { connection } from './api/src/database/connection';
import { NotablePerson } from './api/src/database/entities/NotablePerson';
import { Photo } from './api/src/database/entities/Photo';
import { readJson } from './api/src/helpers/readFile';
import { Result } from './scraper/src/lib/scrape';
import { WikipediaData } from './scraper/src/lib/getWikipediaInfo';
import { glob, getImageFilename } from './scraper/src/lib/helpers';
import { mapValues } from 'lodash';

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
        const image = json.wikipediaData.image;
        if (c && image) {
          const metadata = mapValues(image.info.extmetadata, f => f!.value);
          const photo = new Photo();
          photo.addedAt = new Date();
          photo.sourceUrl = image.info.descriptionurl;

          photo.artist = null;
          photo.description = null;
          photo.credits = null;

          const isCopyrighted = metadata.Copyrighted
            ? metadata.Copyrighted.toLowerCase()
            : null;
          switch (isCopyrighted) {
            case 'false':
              photo.isCopyrighted = false;
              break;
            case 'true':
              photo.isCopyrighted = true;
              break;
            default:
              photo.isCopyrighted = true;
          }

          const isAttributionRequired = metadata.AttributionRequired
            ? metadata.AttributionRequired.toLowerCase()
            : null;
          switch (isAttributionRequired) {
            case 'false':
              photo.isAttributionRequired = false;
              break;
            case 'true':
              photo.isAttributionRequired = true;
              break;
            default:
              photo.isAttributionRequired = true;
          }

          photo.licence = metadata.License || null;
          photo.takenAt = metadata.DateTimeOriginal
            ? new Date(metadata.DateTimeOriginal)
            : null;

          photo.s3Path = `/notable-people/${getImageFilename(
            c.slug,
            image.info.thumburl,
          )}`;

          c.mainPhoto = photo;

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
