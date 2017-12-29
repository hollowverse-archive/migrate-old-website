// tslint:disable no-console no-non-null-assertion max-func-body-length

import { connection } from './api/src/database/connection';
import { NotablePerson } from './api/src/database/entities/NotablePerson';
import { User } from './api/src/database/entities/User';
import { NotablePersonEvent } from './api/src/database/entities/NotablePersonEvent';
import { NotablePersonEventComment } from './api/src/database/entities/NotablePersonEventComment';
import { NotablePersonLabel } from './api/src/database/entities/NotablePersonLabel';
import { EventLabel } from './api/src/database/entities/EventLabel';
import { readJson } from './api/src/helpers/readFile';
import { findKey, intersectionWith, kebabCase } from 'lodash';
import * as uuid from 'uuid/v4';

type FirebaseExport = {
  notablePersons: {
    [x: string]: {
      name: string;
      summary: string | null;
      labels: string[];
      photoUrl: string;
      oldSlug: string;
      events: [
        {
          id: number;
          isQuoteByNotablePerson?: true;
          quote: string;
          postedAt: number;
          labels: string[];
          happenedOn?: number;
          sourceName: string;
          sourceUrl: string;
          userComment: string;
          userId: string;
        }
      ];
    };
  };
  slugToID: {
    [slug: string]: string;
  };
};

connection
  .then(async db =>
    db.transaction(async entityManager => {
      const users = db.getRepository(User);
      const notablePeople = db.getRepository(NotablePerson);
      const notablePersonLabels = db.getRepository(NotablePersonLabel);
      const notablePersonLablesToSave = new Map<string, NotablePersonLabel>();
      let user = await users.findOne({ email: 'editor@hollowverse.com' });

      if (!user) {
        user = new User();
        user.id = uuid();
        user.fbId = '116989929051706';
        user.email = 'editor@hollowverse.com';
        user.name = 'Hollowverse Editor';
        user.signedUpAt = new Date();
        await entityManager.save(user);
      }

      const json = await readJson<FirebaseExport>('firebaseExport.json');

      const eventLabels = new Set<string>();
      Object.values(json.notablePersons).forEach(np => {
        np.events.forEach(e => {
          e.labels.forEach(text => {
            eventLabels.add(kebabCase(text));
          });
        });
      });

      const savedEventLabels = await entityManager.save(
        Array.from(eventLabels.values()).map(text => {
          const label = new EventLabel();
          label.id = uuid();
          label.createdAt = new Date();
          label.text = text;

          return label;
        }),
      );

      return Promise.all(
        Object.entries(json.notablePersons).map(
          async ([id, { name, labels, events, summary, oldSlug }]) => {
            const notablePerson =
              (await notablePeople.findOne({
                where: { oldSlug },
                relations: ['labels'],
              })) || new NotablePerson();
            notablePerson.id = notablePerson.id || uuid();
            notablePerson.name = notablePerson.name || name;
            notablePerson.slug =
              notablePerson.slug || findKey(json.slugToID, v => v === id)!;
            notablePerson.summary = notablePerson.summary || summary;
            notablePerson.oldSlug = notablePerson.oldSlug || oldSlug;

            notablePerson.labels = Promise.resolve([
              ...(await notablePerson.labels),
              ...(await Promise.all(
                labels.map(kebabCase).map(async text => {
                  const saved =
                    (await notablePersonLabels.findOne({ text })) ||
                    notablePersonLablesToSave.get(text);

                  if (saved) {
                    return saved;
                  }

                  const label = new NotablePersonLabel();
                  label.id = uuid();
                  label.text = text;
                  label.createdAt = new Date();
                  notablePersonLablesToSave.set(text, label);

                  return label;
                }),
              )),
            ]);

            await entityManager.save(
              Array.from(notablePersonLablesToSave.values()),
            );

            await entityManager.save(notablePerson);

            await entityManager.save(
              await Promise.all(
                events
                  .filter(event => event.isQuoteByNotablePerson === true)
                  .map(async ev => {
                    const event = new NotablePersonEvent();
                    event.id = uuid();
                    event.type = 'quote';
                    event.labels = [];
                    event.sourceUrl = ev.sourceUrl;
                    event.isQuoteByNotablePerson =
                      ev.isQuoteByNotablePerson || false;
                    event.quote = ev.quote;
                    event.happenedOn = ev.happenedOn
                      ? new Date(ev.happenedOn)
                      : null;
                    event.owner = user!;
                    event.postedAt = new Date(ev.postedAt);
                    event.notablePerson = notablePerson;

                    event.labels = intersectionWith(
                      savedEventLabels,
                      ev.labels.map(kebabCase),
                      (a: EventLabel, text: string) => a.text === text,
                    );

                    const comment = new NotablePersonEventComment();
                    comment.id = uuid();
                    comment.event = event;
                    comment.text = ev.userComment;
                    comment.owner = user!;
                    comment.postedAt = new Date(ev.postedAt);

                    event.comments = [comment];

                    return event;
                  }),
              ),
            );

            return notablePerson;
          },
        ),
      );
    }),
  )
  .then(() => {
    console.info('Firebase data imported successfully');
    process.exit(0);
  })
  .catch(e => {
    console.error('Error importing data:', e.message || e);
    process.exit(1);
  });
