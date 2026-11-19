# paint-pallet

## Preview in an Orca tab

Run `npm run dev:renderer` from the app checkout and keep the terminal running.
Open `http://127.0.0.1:5173` in Orca's built-in browser to inspect the UI and use
the Palette workspace. Drop a binary STL up to 32 MiB onto the Model viewport to
inspect it in the tab. For larger STLs, run `npm start` to use the desktop app's
native worker.

## Generate paint recipes from reference images

In the desktop app, import images into the Palette workspace and choose
**Generate AI recipes**. Select up to four references, enter an OpenAI API key
with access to GPT-4.1 mini, and choose **Send to OpenAI and generate**. Each
request can create one to six recipes with editable shadow, midtone, and
highlight swatches and suggested acrylic mixes. With a model open, choose
**Project** then **Save project** to keep the recipes with the references and
model. Lighting, camera settings, and paint pigments can affect the results,
so treat the swatches and mixes as estimates.

The app sends resized PNG copies of the selected images, each at most 1024
pixels on the longest side, to the OpenAI Responses API. The desktop app clears
the key field on submission and never saves the key to disk. Requests time out
after 60 seconds. OpenAI API usage charges apply. The app sets `store: false`
and OpenAI's API data policies still apply. See the [GPT-4.1 mini model
documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini),
[image input guide](https://developers.openai.com/api/docs/guides/images-vision),
and [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data).

**Extract colors offline** creates swatch recipes by clustering colors from all
imported references. It is available in both the desktop app and the browser
preview and requires no key or network request.
