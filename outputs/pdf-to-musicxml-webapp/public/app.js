const form = document.querySelector("#convertForm");
const fileInput = document.querySelector("#fileInput");
const dropzone = document.querySelector("#dropzone");
const dropTitle = document.querySelector("#dropTitle");
const dropHint = document.querySelector("#dropHint");
const fileCard = document.querySelector("#fileCard");
const fileName = document.querySelector("#fileName");
const fileMeta = document.querySelector("#fileMeta");
const clearFile = document.querySelector("#clearFile");
const convertButton = document.querySelector("#convertButton");
const result = document.querySelector("#result");
const resultTitle = document.querySelector("#resultTitle");
const resultMessage = document.querySelector("#resultMessage");
const downloadLink = document.querySelector("#downloadLink");
const tabs = [...document.querySelectorAll(".tab")];
const steps = [...document.querySelectorAll(".step")];
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let selectedFile = null;
function setStep(index) {
  steps.forEach((step, itemIndex) => {
    step.classList.toggle("done", itemIndex < index);
    step.classList.toggle("active", itemIndex === index);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setFile(file) {
  if (file && file.size > MAX_FILE_BYTES) {
    selectedFile = null;
    fileInput.value = "";
    convertButton.disabled = true;
    resultTitle.textContent = "Plik jest za duzy";
    resultMessage.textContent = "Wgraj PDF albo obraz do 5 MB. PDF moze miec maksymalnie 10 stron.";
    result.classList.add("warning");
    result.classList.remove("hidden");
    return;
  }

  selectedFile = file;
  convertButton.disabled = !file;
  result.classList.add("hidden");
  result.classList.remove("warning");

  if (!file) {
    fileInput.value = "";
    fileCard.classList.add("hidden");
    dropTitle.textContent = "Przeciagnij PDF z nutami tutaj";
    dropHint.textContent = "albo kliknij, aby wybrac plik";
    setStep(0);
    return;
  }

  fileName.textContent = file.name;
  fileMeta.textContent = `${file.type || "plik"} - ${formatBytes(file.size)}`;
  fileCard.classList.remove("hidden");
  dropTitle.textContent = "Plik wybrany";
  dropHint.textContent = "Mozesz uruchomic konwersje albo wybrac inny plik";
  setStep(0);
}

function setBusy(isBusy) {
  convertButton.disabled = isBusy || !selectedFile;
  convertButton.querySelector("span").textContent = isBusy ? "Converting..." : "Start converting";
  tabs.forEach((tab) => {
    tab.disabled = isBusy;
  });
}

function setDownload(payload) {
  const engine = payload.engine || "demo";
  downloadLink.href = payload.downloadUrl;
  downloadLink.target = "_self";
  downloadLink.download = payload.filename || "converted.musicxml";

  const realEngine = engine === "audiveris";
  const isPagesZip = payload.filename && payload.filename.toLowerCase().endsWith(".zip");
  result.classList.toggle("warning", !realEngine);
  resultTitle.textContent = realEngine
    ? isPagesZip
      ? "Paczka MusicXML jest gotowa"
      : "Plik MusicXML jest gotowy"
    : "Pobrany zostanie plik demonstracyjny";
  resultMessage.textContent = realEngine
    ? isPagesZip
      ? `PDF wielostronicowy zostal przekonwertowany stronami. Pobierzesz ZIP z ${payload.pages || "kilkoma"} plikami MusicXML.`
      : "Konwersja zostala wykonana przez silnik OMR. Mozesz pobrac plik i otworzyc go w edytorze nut."
    : "Backend dziala, ale nie znalazl lokalnego Audiveris. Zainstaluj Audiveris albo ustaw AUDIVERIS_CMD, zeby otrzymywac realny MusicXML z PDF.";

  if (realEngine && payload.analysis && Array.isArray(payload.analysis.timeSignatures) && payload.analysis.timeSignatures.length) {
    const signatures = payload.analysis.timeSignatures
      .map((item) => `takt ${item.measure}: ${item.signature}`)
      .join(", ");
    resultMessage.textContent += ` Wykryte metrum: ${signatures}.`;
  }

  result.classList.remove("hidden");
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((item) => item.classList.remove("active"));
    tab.classList.add("active");
    if (tab.dataset.kind === "image") {
      fileInput.accept = ".png,.jpg,.jpeg,image/png,image/jpeg";
      dropTitle.textContent = selectedFile ? "Plik wybrany" : "Przeciagnij obraz nut tutaj";
    } else {
      fileInput.accept = ".pdf,application/pdf";
      dropTitle.textContent = selectedFile ? "Plik wybrany" : "Przeciagnij PDF z nutami tutaj";
    }
  });
});

fileInput.addEventListener("change", () => {
  setFile(fileInput.files[0] || null);
});

clearFile.addEventListener("click", () => {
  setFile(null);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragging");
  });
});

dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (file) setFile(file);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedFile) return;

  setBusy(true);
  setStep(1);

  try {
    const response = await fetch("/api/convert", {
      method: "POST",
      headers: {
        "content-type": selectedFile.type || "application/octet-stream",
        "x-file-name": encodeURIComponent(selectedFile.name)
      },
      body: selectedFile
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Konwersja nie powiodla sie.");
    }

    setStep(2);
    const payload = await response.json();
    setDownload(payload);
  } catch (error) {
    resultTitle.textContent = "Konwersja przerwana";
    resultMessage.textContent = error.message;
    result.classList.add("warning");
    result.classList.remove("hidden");
    setStep(0);
  } finally {
    setBusy(false);
  }
});
