import * as mapModule from "../map.js";

let previousGlobals = {};
const mapExportNames = Object.keys(mapModule);

export async function mount(ctx) {
    ctx.view.innerHTML = `
        <div class="admin-map-host">
            <div id="form"></div>
            <div class="table-scroll"><table id="table"></table></div>
        </div>
    `;

    previousGlobals = {};
    mapExportNames.forEach(name => {
        previousGlobals[name] = window[name];
        window[name] = mapModule[name];
    });

    await mapModule.loadMapEditor();
}

export function unmount() {
    mapExportNames.forEach(name => {
        if (previousGlobals[name] === undefined) {
            delete window[name];
        } else {
            window[name] = previousGlobals[name];
        }
    });
    document.removeEventListener("keydown", mapModule.handleMapKeyboard);
}
