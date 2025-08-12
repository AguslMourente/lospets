(async () => {
  const r = await fetch("/health");
  console.log("health:", await r.json());
})();
