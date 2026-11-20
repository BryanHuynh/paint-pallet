# paint-pallet

## Preview in an Orca tab

Run `npm run dev:renderer` from the app checkout and keep the terminal running.
Open `http://127.0.0.1:5173` in Orca's built-in browser to inspect the UI and use
the Palette workspace. Drop a binary STL up to 32 MiB onto the Model viewport to
inspect it in the tab. For larger STLs, run `npm start` to use the desktop app's
native worker.

## Working with projects

Open **Tutorial** from the toolbar for a walkthrough of model setup, recipes,
painting, lighting, and saving. You can follow it with your own model or load
the bundled Field Robot in the first step.

Use **Project → New from model** to start painting an STL or OBJ. Open a
`.paintproject` from the Project menu, the recent projects list, or by dropping
the file onto the model viewport. **Save project** updates the current file.
**Save project as** writes a copy and makes it the current file. On Windows,
use Ctrl+N, Ctrl+O, Ctrl+S, and Ctrl+Shift+S.
When switching projects with unsaved edits, choose Save, Discard changes, or
Cancel. If another program changes or moves the current project file, use
**Save project as** to save your edits to a new file.

Each light source can be aimed independently. Its intensity weights its
contribution to the combined exposure shown in **Lighting levels**. Projects
from earlier versions keep the active lighting and edge masks. Directions
from older inactive lighting setups are available as lights at 0% intensity.

Choose a recipe under **Shadow coat** to brush, erase, or fill. The same
recipe is selected in **Palette**. Older painted regions are assigned to
their recipes when opened. Turn off **Show lighting** for a view that
emphasizes bevels and ridges while you paint.

## Generate paint recipes from reference images

Install a recent version of the Codex CLI and sign in with `codex login`.
In the desktop app, import images into the Palette workspace and choose
**Generate AI recipes**. Select up to four references and choose **Generate with Codex**. Each
request can create one to six recipes with editable shadow, midtone, and
highlight swatches and suggested acrylic mixes. With a model open, choose
**Project** then **Save project** to keep the recipes with the references and
model. Lighting, camera settings, and paint pigments can affect the results,
so treat the swatches and mixes as estimates.

Codex analyzes resized copies of the selected images using your CLI sign-in.
The app removes its temporary files when the request finishes. Requests time out
after two minutes.

**Extract colors offline** creates swatch recipes by clustering colors from all
imported references. It is available in both the desktop app and the browser
preview and requires no key or network request.
