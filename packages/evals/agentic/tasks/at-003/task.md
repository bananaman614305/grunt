# Fix pagination

`paginate.js` slices a list into 1-based pages, but the first page's items
never show up and the page count is wrong when the last page is partial.
Page 1 must start at the first item, and `totalPages` must count a final
partial page as a page. Fix `paginate`; `node test.js` checks the result.
