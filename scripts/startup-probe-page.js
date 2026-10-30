document.querySelector("button").addEventListener("click", () => {
  const output = document.querySelector("output");
  output.textContent = String(Number(output.textContent) + 1);
});
