import { HandleEvents } from './handleEvents';
import { htmlElementAsString, Severity } from 'encode-yt-monitor-utils';
import { EventTypes, BreadCrumbTypes } from 'encode-yt-monitor-shared';
import { breadcrumb, handleConsole } from 'encode-yt-monitor-core';
import { addReplaceHandler } from './replace';
export function setupReplace(): void {
  // request event
  addReplaceHandler({
    callback: (data) => {
      HandleEvents.handleHttp(data, BreadCrumbTypes.XHR);
    },
    type: EventTypes.XHR,
  });
  addReplaceHandler({
    callback: (data) => {
      HandleEvents.handleHttp(data, BreadCrumbTypes.FETCH);
    },
    type: EventTypes.FETCH,
  });

  // error event
  addReplaceHandler({
    callback: (error) => {
      HandleEvents.handleError(error);
    },
    type: EventTypes.ERROR,
  });
  addReplaceHandler({
    callback: (data) => {
      HandleEvents.handleUnhandleRejection(data);
    },
    type: EventTypes.UNHANDLEDREJECTION,
  });

  // console event
  addReplaceHandler({
    callback: (data) => {
      handleConsole(data);
    },
    type: EventTypes.CONSOLE,
  });

  // router event
  addReplaceHandler({
    callback: (e: HashChangeEvent) => {
      HandleEvents.handleHashchange(e);
    },
    type: EventTypes.HASHCHANGE,
  });
  addReplaceHandler({
    callback: (data) => {
      HandleEvents.handleHistory(data);
    },
    type: EventTypes.HISTORY,
  });

  // dom event
  addReplaceHandler({
    callback: (data) => {
      const htmlString = htmlElementAsString(data.data.activeElement as HTMLElement);
      if (htmlString) {
        breadcrumb.push({
          type: BreadCrumbTypes.CLICK,
          category: breadcrumb.getCategory(BreadCrumbTypes.CLICK),
          data: htmlString,
          level: Severity.Info,
        });
      }
    },
    type: EventTypes.DOM,
  });
}
