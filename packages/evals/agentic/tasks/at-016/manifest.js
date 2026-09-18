"use strict";

// Every plugin the kernel loads. The order of this list does not matter: the
// kernel sorts by each plugin's `priority`, and two plugins may not share one.
module.exports = {
  plugins: [require("./plugins/size.js"), require("./plugins/audit.js")],
};
