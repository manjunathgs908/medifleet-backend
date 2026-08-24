/**
 * tests/migrateSeoJsonLd.test.js
 * ============================================================
 * The migration, run against a stub collection instead of MongoDB.
 *
 * A migration you cannot test until it is pointed at production is not a safe
 * migration. mongoose.connect and the collection handle are mocked, so every
 * read and write the script issues is recorded and asserted on — in
 * particular that a dry run issues no writes at all, and that step 1 never
 * emits a $unset or a $rename.
 *
 * These assertions are about the operations SENT to Mongo, not about Mongo
 * executing them. What the filters select is argued for in the script; what
 * is checked here is that the script cannot send a destructive operation in a
 * mode that is meant to be read-only, and cannot run step 2 before step 1.
 * ============================================================
 */
'use strict';

const mongoose = require('mongoose');

const script = require('../scripts/migrateSeoJsonLd');
const { main, NEEDS_COPY, SAFE_TO_DROP, DIVERGED } = script;

// The four questions the script asks, keyed by the filter it asks them with.
const K = {
  total: JSON.stringify({}),
  needsCopy: JSON.stringify(NEEDS_COPY),
  safeToDrop: JSON.stringify(SAFE_TO_DROP),
  diverged: JSON.stringify(DIVERGED),
  done: JSON.stringify({ jsonLd: { $exists: true }, schema: { $exists: false } }),
  anySchema: JSON.stringify({ schema: { $exists: true } }),
  anyJsonLd: JSON.stringify({ jsonLd: { $exists: true } }),
};

// `counts` maps a filter to what the collection would answer. An unmapped
// filter throws rather than returning 0, so a question this stub was not told
// about shows up as a failure instead of hiding.
function stubCollection(counts) {
  const writes = [];
  const col = {
    countDocuments: jest.fn(async (filter) => {
      const key = JSON.stringify(filter);
      if (key in counts) return counts[key];
      throw new Error('unexpected countDocuments filter: ' + key);
    }),
    findOne: jest.fn(async () => ({ slug: 'ambulance-service-whitefield', title: 'A title' })),
    find: jest.fn(() => ({ limit: () => ({ toArray: async () => [{ slug: 'x' }] }) })),
    updateMany: jest.fn(async (filter, update) => {
      writes.push({ filter, update });
      return { matchedCount: 1, modifiedCount: 1 };
    }),
  };
  return { col, writes };
}

let logged;
let connectionDescriptor;

function install(counts) {
  const { col, writes } = stubCollection(counts);
  jest.spyOn(mongoose, 'connect').mockResolvedValue();
  jest.spyOn(mongoose, 'disconnect').mockResolvedValue();
  // mongoose.connection is a getter and there is no connection to read from
  // without a server. Swapped out here, restored in afterEach.
  connectionDescriptor = Object.getOwnPropertyDescriptor(mongoose, 'connection');
  Object.defineProperty(mongoose, 'connection', {
    configurable: true,
    value: { db: { collection: () => col } },
  });
  return { col, writes };
}

beforeEach(() => {
  logged = [];
  connectionDescriptor = null;
  jest.spyOn(console, 'log').mockImplementation((...a) => logged.push(a.join(' ')));
  process.env.MONGO_URI = 'mongodb+srv://user:secret@cluster.example.net/medifleet?retryWrites=true';
});

afterEach(() => {
  jest.restoreAllMocks();
  if (connectionDescriptor) Object.defineProperty(mongoose, 'connection', connectionDescriptor);
});

const output = () => logged.join('\n');

// Seven legacy documents, five already migrated, none diverged.
const LEGACY = {
  [K.total]: 12,
  [K.needsCopy]: 7,
  [K.safeToDrop]: 0,
  [K.diverged]: 0,
  [K.done]: 5,
};

describe('dry run is the default, and writes nothing', () => {
  test('no flags: not a single write is issued', async () => {
    const { writes } = install(LEGACY);
    await main([]);
    expect(writes).toHaveLength(0);
  });

  test('it says exactly how many documents would be migrated', async () => {
    install(LEGACY);
    await main([]);
    expect(output()).toContain('==> 7 document(s) would be migrated.');
    expect(output()).toContain('DRY RUN (read-only, writes nothing)');
    expect(output()).toContain('Dry run: nothing was written.');
  });

  test('--cleanup on its own is also a dry run', async () => {
    const { writes } = install({ ...LEGACY, [K.needsCopy]: 0, [K.safeToDrop]: 7 });
    await main(['--cleanup']);
    expect(writes).toHaveLength(0);
    expect(output()).toContain('DRY RUN');
    expect(output()).toContain('==> 7 document(s) would have their redundant `schema` key dropped.');
  });

  test('credentials are never printed', async () => {
    install(LEGACY);
    await main([]);
    expect(output()).not.toContain('secret');
    expect(output()).toContain('cluster.example.net/medifleet');
  });

  test('nothing to do is reported, not written around', async () => {
    const { writes } = install({ ...LEGACY, [K.needsCopy]: 0 });
    await main([]);
    expect(writes).toHaveLength(0);
    expect(output()).toContain('Nothing to migrate.');
  });
});

describe('step 1 copies, and only copies', () => {
  // countDocuments is asked for needsCopy twice: once up front, once as the
  // readback after the write. This answers 7 then 0.
  const copyThenClear = (col) => {
    let asked = 0;
    col.countDocuments.mockImplementation(async (filter) => {
      const key = JSON.stringify(filter);
      if (key === K.needsCopy) return (asked += 1) > 1 ? 0 : 7;
      if (key === K.total) return 12;
      if (key === K.done) return 5;
      if (key === K.safeToDrop || key === K.diverged) return 0;
      throw new Error('unexpected filter ' + key);
    });
  };

  test('it issues one aggregation $set, against the legacy filter', async () => {
    const { col, writes } = install({});
    copyThenClear(col);

    await main(['--apply']);

    expect(writes).toHaveLength(1);
    expect(writes[0].filter).toEqual(NEEDS_COPY);
    expect(writes[0].update).toEqual([{ $set: { jsonLd: '$schema' } }]);
    // $exists:false is what keeps an existing jsonLd from being overwritten.
    expect(writes[0].filter.jsonLd).toEqual({ $exists: false });
  });

  test('it never emits $unset or $rename — the legacy key survives step 1', async () => {
    const { col, writes } = install({});
    copyThenClear(col);

    await main(['--apply']);

    const sent = JSON.stringify(writes);
    expect(sent).not.toContain('$unset');
    expect(sent).not.toContain('$rename');
  });

  test('a document that was not copied stops the run', async () => {
    const { col } = install({});
    // The readback still finds legacy documents: the write did not take.
    col.countDocuments.mockImplementation(async (filter) => {
      const key = JSON.stringify(filter);
      if (key === K.needsCopy) return 7;
      if (key === K.total) return 12;
      if (key === K.done) return 5;
      return 0;
    });

    await expect(main(['--apply'])).rejects.toThrow(/were not copied/);
  });

  test('a copy that produced a mismatched value stops the run', async () => {
    const { col } = install({});
    let asked = 0;
    col.countDocuments.mockImplementation(async (filter) => {
      const key = JSON.stringify(filter);
      if (key === K.needsCopy) return (asked += 1) > 1 ? 0 : 7;
      if (key === K.diverged) return asked > 1 ? 3 : 0; // divergence appeared
      if (key === K.total) return 12;
      if (key === K.done) return 5;
      return 0;
    });

    await expect(main(['--apply'])).rejects.toThrow(/mismatched value/);
  });
});

describe('step 2 is gated behind step 1', () => {
  test('it refuses to run while any document still has schema only', async () => {
    install({ ...LEGACY, [K.needsCopy]: 3, [K.safeToDrop]: 4 });
    await expect(main(['--cleanup', '--apply'])).rejects.toThrow(/Run step 1 first/);
  });

  test('it drops the key only from documents whose copies are identical', async () => {
    const { col, writes } = install({});
    col.countDocuments.mockImplementation(async (filter) => {
      const key = JSON.stringify(filter);
      if (key === K.needsCopy) return 0;
      if (key === K.safeToDrop) return 7;
      if (key === K.diverged) return 0;
      if (key === K.total) return 12;
      if (key === K.done) return 5;
      if (key === K.anySchema) return 0; // readback: none left
      if (key === K.anyJsonLd) return 12;
      throw new Error('unexpected filter ' + key);
    });

    await main(['--cleanup', '--apply']);

    expect(writes).toHaveLength(1);
    expect(writes[0].filter).toEqual(SAFE_TO_DROP);
    expect(writes[0].update).toEqual({ $unset: { schema: '' } });
  });

  test('diverged documents are left alone and reported', async () => {
    const { col, writes } = install({});
    col.countDocuments.mockImplementation(async (filter) => {
      const key = JSON.stringify(filter);
      if (key === K.needsCopy) return 0;
      if (key === K.safeToDrop) return 7;
      if (key === K.diverged) return 2;
      if (key === K.total) return 12;
      if (key === K.done) return 3;
      if (key === K.anySchema) return 2; // exactly the diverged ones remain
      if (key === K.anyJsonLd) return 12;
      throw new Error('unexpected filter ' + key);
    });

    await main(['--cleanup', '--apply']);

    // The equality guard travels with the $unset filter, so a diverged
    // document cannot match it.
    expect(writes[0].filter.$expr).toEqual({ $eq: ['$schema', '$jsonLd'] });
    expect(output()).toContain('Diverged documents are never written to by either step.');
  });
});

describe('preconditions', () => {
  test('a missing MONGO_URI fails before anything connects', async () => {
    delete process.env.MONGO_URI;
    const connect = jest.spyOn(mongoose, 'connect').mockResolvedValue();
    await expect(main([])).rejects.toThrow(/MONGO_URI is not set/);
    expect(connect).not.toHaveBeenCalled();
  });

  test('requiring the script does not start a migration', () => {
    // require.main is jest's runner here, not the script, so the auto-run
    // block at the bottom must not have fired when this file loaded it.
    const connect = jest.spyOn(mongoose, 'connect').mockResolvedValue();
    require('../scripts/migrateSeoJsonLd');
    expect(connect).not.toHaveBeenCalled();
  });
});
