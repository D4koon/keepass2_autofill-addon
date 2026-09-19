import { KeeLog } from "~/common/Logger";
import { isFirefox, isForbiddenUrl } from "~/env";

// Firefox fetch files from cache instead of reloading changes from disk,
// hmr will not work as Chromium based browser
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {

    if (frameId !== 0) { return; }

  if (isForbiddenUrl(url))
    {return;}

  // inject the latest scripts
  chrome.tabs.executeScript(tabId, {
    file: `${isFirefox ? "" : "."}/dist/page/index.global.js`,
    allFrames: true,
    runAt: "document_end"
  }).catch(error => KeeLog.error("Failed to inject content script", error));
});
