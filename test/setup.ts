import './helpers/browserEnv';
import { beforeEach, vi } from 'vitest';
import { EventTypes } from 'encode-yt-monitor-shared';
import { _support } from 'encode-yt-monitor-utils';

beforeEach(() => {
  vi.restoreAllMocks();
  if (_support.replaceFlag) {
    for (const key of Object.keys(_support.replaceFlag)) {
      delete _support.replaceFlag[key as EventTypes];
    }
  }
});
