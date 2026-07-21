async function loadMosaic() {
  const container = document.getElementById("mosaic");
  if (!container) return;

  const response = await fetch("/api/mosaic");
  const data = await response.json();
  container.innerHTML = "";

  for (const tile of data.tiles ?? []) {
    const el = document.createElement("div");
    el.className = "tile";
    el.style.background = tile.colorHex;
    el.title = tile.publicSlug;
    el.tabIndex = 0;
    if (location.hash === `#${tile.publicSlug}`) {
      el.style.outline = "3px solid white";
      el.scrollIntoView({ block: "center" });
    }
    container.appendChild(el);
  }
}

loadMosaic().catch(() => {
  const container = document.getElementById("mosaic");
  if (container) container.textContent = "Unable to load mosaic.";
});
