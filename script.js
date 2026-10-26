(function () {
  "use strict";

  // ---------- Sample Data ----------
  const defaultEmployees = [
    { id: "EMP-001", name: "Andi Pratama", jabatan: "Anggota", status: "Aktif", initials: "AP" },
    { id: "EMP-002", name: "Siti Rahmawati", jabatan: "Ketua", status: "Aktif", initials: "SR" },
    { id: "EMP-003", name: "Budi Santoso", jabatan: "Anggota", status: "Aktif", initials: "BS" },
    { id: "EMP-004", name: "Maya Lestari", jabatan: "Wakil", status: "Aktif", initials: "ML" },
    { id: "EMP-005", name: "Rizki Maulana", jabatan: "Anggota", status: "Aktif", initials: "RM" },
  ];
  let employees = JSON.parse(localStorage.getItem("qr_employees") || "null") || defaultEmployees;

  function saveEmployees() {
    localStorage.setItem("qr_employees", JSON.stringify(employees));
  }

  // Attendance today (loaded from localStorage or default)
  let attendance = JSON.parse(localStorage.getItem("qr_attendance") || "null") || [
    { id: "EMP-001", name: "Andi Pratama", jabatan: "Anggota", time: "08:02", status: "Hadir" },
    { id: "EMP-002", name: "Siti Rahmawati", jabatan: "Ketua", time: "08:15", status: "Hadir" },
    { id: "EMP-003", name: "Budi Santoso", jabatan: "Anggota", time: "08:32", status: "Hadir" },
    { id: "EMP-004", name: "Maya Lestari", jabatan: "Wakil", time: "—", status: "Tidak hadir" },
  ];

  // ---------- Helpers ----------
  function $(sel, ctx = document) { return ctx.querySelector(sel); }
  function $$(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }


  function avatarHtml(e){
    return `<span class="miniavatar">${
      e.photo
        ? `<img.src="${e.photo}" alt="" style="width:100%;height:100%;object-fit:cover">`
        :e.initials
    }</span>`;
  }

  function showToast(msg, type = "") {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (type ? " " + type : "");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  function saveAttendance() {
    localStorage.setItem("qr_attendance", JSON.stringify(attendance));
  }

  function getTodayStr() {
    const d = new Date();
    const days = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
    const months = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
      "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
    return `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  }

  // ---------- Digital Clock (WIB) ----------
  function updateClock() {
    const now = new Date();
    // Format as HH:MM:SS WIB
    const opts = { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
    const timeStr = now.toLocaleTimeString("id-ID", opts).replace(/\./g, ":");
    const el = $("#clock");
    if (el) el.textContent = timeStr + " WIB";
  }

  // ---------- Page Navigation ----------
  const pageTitles = {
    dashboard: "Dashboard",
    pegawai: "Master Data & QR",
    absensi: "Monitoring Absensi",
    laporan: "Export Hasil Absen",
    jadwal: "Jadwal Event",
    perangkat: "Perangkat",
    pengaturan: "Pengaturan",
  };

  function goToPage(page) {
    $$(".sectionpage").forEach(s => s.classList.remove("active"));
    const target = $(`#page-${page}`);
    if (target) target.classList.add("active");

    $$(".nav button, .mobile-tabs button").forEach(b => {
      b.classList.toggle("active", b.dataset.page === page);
    });

    const titleEl = $("#pageTitle");
    if (titleEl) titleEl.textContent = pageTitles[page] || page;

    // Close mobile sidebar
    $(".sidebar")?.classList.remove("open");
  }

  // ---------- Role Switch ----------
  function updateRole(role) {
    const isAdmin = role === "admin";
    $("#profileName").textContent = isAdmin ? "Admin" : "Petugas";
    $("#profileRole").textContent = isAdmin ? "Administrator" : "Petugas Absen";
    $("#profileAvatar").textContent = isAdmin ? "A" : "P";
    $("#greeting").textContent = `Selamat datang, ${isAdmin ? "Admin" : "Petugas"} 👋`;

    // Hide some nav for petugas
    $$(".nav button").forEach(btn => {
      const p = btn.dataset.page;
      if (p === "pegawai" || p === "laporan") {
        btn.style.display = isAdmin ? "" : "none";
      }
    });
  }

  // ---------- Render Tables ----------
  function renderAttendanceTables() {
    const present = attendance.filter(a => a.status === "Hadir").length;
    const absent = attendance.filter(a => a.status === "Tidak hadir").length;
    const total = employees.length;
    const belum = Math.max(0, total - present - absent);

    if ($("#presentCount")) $("#presentCount").textContent = present;

    // Dashboard mini table
    const rows = $("#attendanceRows");
    if (rows) {
      rows.innerHTML = attendance.slice(0, 6).map(a => {
        const emp = employees.find(e => e.id === a.id) || { initials: "??" };
        const badgeClass = a.status === "Hadir" ? "ok" : "absent";
        return `<tr>
          <td><div class="person">${avatarHtml(emp)}${a.name}</div></td>
          <td>${a.jabatan}</td>
          <td>${a.time}</td>
          <td><span class="badge ${badgeClass}">${a.status}</span></td>
        </tr>`;
      }).join("");
    }

    // Full attendance table
    const full = $("#fullAttendance");
    if (full) {
      const today = getTodayStr().replace(/^\w+, /, "").replace(/ \d{4}$/, ""); // rough date
      full.innerHTML = attendance.map(a => {
        const badgeClass = a.status === "Hadir" ? "ok" : "absent";
        return `<tr>
          <td>${a.name}</td>
          <td>${a.jabatan}</td>
          <td>${today}</td>
          <td>${a.time}</td>
          <td><span class="badge ${badgeClass}">${a.status}</span></td>
        </tr>`;
      }).join("");
    }

    // Employee master
    const empRows = $("#employeeRows");
    if (empRows) {
      empRows.innerHTML = employees.map(e => `
        <tr>
          <td>${e.name}</td>
          <td>${e.jabatan}</td>
          <td>${e.id}</td>
          <td><span class="badge ok">${e.status}</span></td>
          <td>
            <button class="btn btn-soft editBtn" data-id="${e.id}">Edit</button>
            <button class="btn btn-soft qrBtn" data-id="${e.id}">Buat QR</button>
          </td>
        </tr>`).join("");
    }
  }

  // ---------- Modal System ----------
  const modalBack = $("#modalback");
  let modalMode = null;
  let modalData = null;

  function openModal(title, desc, fieldsHtml, mode, data = null) {
    $("#modalTitle").textContent = title;
    $("#modalDesc").textContent = desc;
    $("#modalFields").innerHTML = fieldsHtml;
    modalMode = mode;
    modalData = data;
    modalBack.classList.add("show");
  }

  function closeModal() {
    modalBack.classList.remove("show");
    modalMode = null;
    modalData = null;
    // Stop scanner if running
    if (html5QrCode && html5QrCode.isScanning) {
      html5QrCode.stop().catch(() => {});
    }
  }

  // ---------- QR Code Generation ----------
  function generateQR(empId) {
    const emp = employees.find(e => e.id === empId);
    if (!emp) return showToast("Peserta tidak ditemukan", "error");

    const payload = emp.id;

    openModal(
      `QR Code — ${emp.name}`,
      `ID: ${emp.id} · ${emp.jabatan}`,
      `<div id="qr-priview"><div id="qrcode"></div>
       <p style="font-size:0.85rem;color:var(--text-sub)">Scan QR ini untuk absensi</p>
       <button class="btn btn-soft" id="downloadQR">⬇ Unduh QR</button></div>`,
      "qr"
    );

    // Wait for modal render then create QR
    setTimeout(() => {
      const container = $("#qrcode");
      container.innerHTML = "";
      if (typeof QRCode !== "undefined") {
        new QRCode(container, {
          text: payload,
          width: 220,
          height: 220,
          colorDark: "#000000",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.H
        });
      } else {
        container.innerHTML = "<p>Library QRCode belum dimuat. Pastikan koneksi internet.</p>";
      }

      $("#downloadQR")?.addEventListener("click", () => {
        const img = container.querySelector("img") || container.querySelector("canvas");
        if (img) {
          const link = document.createElement("a");
          link.download = `QR-${emp.id}-${emp.name.replace(/\s+/g, "_")}.png`;
          if (img.tagName === "IMG") {
            link.href = img.src;
          } else {
            link.href = img.toDataURL("image/png");
          }
          link.click();
          showToast("QR berhasil diunduh", "success");
        }
      });
    }, 80);
  }

  // ---------- Camera QR Scanner ----------
  let html5QrCode = null;
  let isHandling = false;

  async function startScanner() {
    openModal(
      "Scan QR Absensi",
      "Arahkan kamera ke QR Code peserta",
      `<div id="reader"></div>
       <div class="scan-status" id="scanStatus">Menyiapkan kamera…</div>
       <div id="scanResult></div>
       <button class="btn btn-soft full" id="stopScan" style="margin-top:12px">Tutup Scanner</button>`,
      "scan"
    );

    setTimeout(async () => {
      if (typeof Html5Qrcode === "undefined") {
        $("#scanStatus").textContent = "Library scanner belum tersedia. Cek koneksi internet.";
        return;
      }

      html5QrCode = new Html5Qrcode("reader");
      const statusEl = $("#scanStatus");

      try {
        await html5QrCode.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText) => {
            // Success
            handleScanResult(decodedText);
          },
          () => {} // ignore errors while scanning
        );
        statusEl.textContent = "Kamera aktif — arahkan ke QR Code";
        statusEl.style.color = "var(--green-600)";
      } catch (err) {
        statusEl.textContent = "Gagal mengakses kamera: " + (err.message || err);
        statusEl.style.color = "var(--red)";
        // Fallback: allow manual ID input
        statusEl.insertAdjacentHTML("afterend", `
          <div class="field" style="margin-top:16px">
            <label>Atau masukkan ID Peserta manual</label>
            <input id="manualId" placeholder="EMP-001">
            <button class="btn btn-primary full" id="manualSubmit" style="margin-top:8px">Absen Manual</button>
          </div>`);
        $("#manualSubmit")?.addEventListener("click", () => {
          const id = $("#manualId").value.trim().toUpperCase();
          if (id) handleScanResult(JSON.stringify({ id }));
        });
      }

      $("#stopScan")?.addEventListener("click", () => {
        if (html5QrCode?.isScanning) {
          html5QrCode.stop().then(closeModal).catch(closeModal);
        } else {
          closeModal();
        }
      });
    }, 100);
  }

  function handleScanResult(text) {
    if (isHandling) return;
    isHandling = true;
    setTimeout (() => {isHandling = false;}, 2000);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Maybe plain ID
      data = { id: text.trim() };
    }

    const empId = (data.id || "").toUpperCase();
    const emp = employees.find(e => e.id === empId);

    if (!emp) {
      showToast("QR tidak dikenali / peserta tidak terdaftar", "error");
      return;
    }

    // Already present?
    const existing = attendance.find(a => a.id === empId);
    if (existing && existing.status === "Hadir") {
      showToast(`${emp.name} sudah absen (${existing.time})`, "gold");
      return;
    }

    // Record attendance
    const now = new Date();
    const timeStr = now.toLocaleTimeString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).replace(/\./g, ":");

    if (existing) {
      existing.time = timeStr;
      existing.status = "Hadir";
    } else {
      attendance.push({
        id: emp.id,
        name: emp.name,
        jabatan: emp.jabatan,
        time: timeStr,
        status: "Hadir"
      });
    }

    saveAttendance();
    renderAttendanceTables();
    showToast(`✓ ${emp.name} berhasil absen pukul ${timeStr}`, "success");

    // Stop scanner after success
    $("#scanResult").innerHTML = `
  <div style="display:flex;gap:12px;align-items:center;margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:12px">
    <div style="width:80px;height:80px;border-radius:12px;overflow:hidden;background:var(--green-800);color:var(--gold-400);display:grid;place-items:center;font-weight:700">
      ${emp.photo ? `<img src="${emp.photo}" alt="" style="width:100%;height:100%;object-fit:cover">` : emp.initials}
    </div>
    <div><strong>${emp.name}</strong><br><small>${emp.jabatan} · ${emp.id}</small><br><small>Hadir pukul ${timeStr}</small></div>
  </div>`;

  
  // ---------- Add / Edit Employee ----------
  function openAddEmployee(editEmp = null) {
    const isEdit = !!editEmp;
    openModal(
      isEdit ? "Edit Peserta" : "Tambah Peserta",
      isEdit ? "Ubah data peserta." : "Masukkan data peserta baru.",
      `<div class="field"><label>Nama Lengkap</label><input id="fName" value="${editEmp?.name || ""}" placeholder="Nama lengkap"></div>
       <div class="field"><label>Jabatan</label>
         <select id="fJabatan">
           <option ${editEmp?.jabatan === "Anggota" ? "selected" : ""}>Anggota</option>
           <option ${editEmp?.jabatan === "Ketua" ? "selected" : ""}>Ketua</option>
           <option ${editEmp?.jabatan === "Wakil" ? "selected" : ""}>Wakil</option>
         </select>
       </div>
      <div class="field"><label>ID Peserta</label><input id="fId" value="${editEmp?.id || ""}" placeholder="EMP-00X" ${isEdit ? "readonly" : ""}></div>
        <div class="field"><label>Foto Peserta</label>
        <input type="file" id="fPhoto" accept="image/*">
        <img id="photoPreview" alt="" style="display:none;width:72px;height:72px;object-fit:cover;border-radius:10px;margin-top:8px">
      </div>`,
      isEdit ? "edit" : "add",
      editEmp
    );
    pendingPhoto = editEmp?.photo || "";
    const preview = $("#photoPreview");
    if (pendingPhoto) {preview.src = pendingPhoto;preview.style.display = "block";}

    $("#Photo").addEventListener("change", async (e)=>{
      const file = e.target.files[0];
      if (!file) return;
      try {
        pendingPhoto = await compressImage(file);
        preview.src = pendingPhoto;
        preview.style.display = "block";
      } catch (err){
        showToast(err.message, "error");
      }
    });
  }

  let pendingPhoto = "";

  function compressImage(file, maxSize = 400, quality = 0.75) {
    return new Promise((resolve, reject) => {
      if (!file.type.startsWith("image/")) return reject(new Error("File harus berupa gambar"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Gagal membaca file"));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Gambar tidak vaild"));
        img.onload = () => {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContaxt("2d").drawImg(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- Event Binding ----------
  function bindEvents() {
    // Nav
    $$(".nav button, .mobile-tabs button").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.page) goToPage(btn.dataset.page);
      });
    });

    // data-go buttons
    document.addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]");
      if (go) goToPage(go.dataset.go);
    });

    // Menu toggle (mobile)
    $("#menuBtn")?.addEventListener("click", () => {
      $(".sidebar").classList.toggle("open");
    });

    // Role
    $("#role")?.addEventListener("change", (e) => updateRole(e.target.value));

    // Scan button
    $("#scanBtn")?.addEventListener("click", startScanner);

    // Add employee
    $("#addEmployee")?.addEventListener("click", () => openAddEmployee());

    // Modal cancel / backdrop
    $("#modalCancel")?.addEventListener("click", closeModal);
    modalBack?.addEventListener("click", (e) => {
      if (e.target === modalBack) closeModal();
    });

    // Modal save
    $("#modalSave")?.addEventListener("click", () => {
      if (modalMode === "add" || modalMode === "edit") {
        const name = $("#fName")?.value.trim();
        const jabatan = $("#fJabatan")?.value;
        const id = ($("#fId")?.value.trim() || "").toUpperCase();
        if (!name || !id) return showToast("Nama dan ID wajib diisi", "error");

        if (modalMode === "add") {
          if (employees.some(e => e.id === id)) return showToast("ID sudah digunakan", "error");
          const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
          employees.push({ id, name, jabatan, status: "Aktif", initials, photo:pendingPhoto });
          showToast("Peserta berhasil ditambahkan", "success");
        } else {
          const emp = employees.find(e => e.id === id);
          if (emp) {
            emp.name = name;
            emp.jabatan = jabatan;
            emp.initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
            emp.photo = pendingPhoto;
            showToast("Data peserta diperbarui", "success");
          }
        }
        saveEmployees();
        renderAttendanceTables();
        closeModal();
      }
    });

    // Dynamic buttons (edit / qr)
    document.addEventListener("click", (e) => {
      const qrBtn = e.target.closest(".qrBtn");
      if (qrBtn) {
        generateQR(qrBtn.dataset.id);
        return;
      }
      const editBtn = e.target.closest(".editBtn");
      if (editBtn) {
        const emp = employees.find(e => e.id === editBtn.dataset.id);
        if (emp) openAddEmployee(emp);
      }
    });

    // Export buttons (demo)
    document.addEventListener("click", (e) => {
      const exp = e.target.closest("[data-export]");
      if (exp) {
        showToast(`Export ${exp.dataset.export} sedang disiapkan… (demo)`, "gold");
      }
    });

    // Search filters
    $("#attendanceSearch")?.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      $$("#fullAttendance tr").forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });

    $("#employeeSearch")?.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase();
      $$("#employeeRows tr").forEach(tr => {
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
      });
    });

    $("#statusFilter")?.addEventListener("change", (e) => {
      const val = e.target.value;
      $$("#fullAttendance tr").forEach(tr => {
        if (val === "all") {
          tr.style.display = "";
        } else {
          tr.style.display = tr.textContent.includes(val) ? "" : "none";
        }
      });
    });

    // Schedule / settings save (demo)
    $("#saveEventEnd")?.addEventListener("click", () => {
      const t = $("#eventEndTime")?.value || "17:00";
      $("#eventState").textContent = `Status sesi: Aktif · Selesai jam ${t}`;
      showToast("Jam selesai event disimpan", "success");
    });

    $("#saveSettings")?.addEventListener("click", () => {
      showToast("Pengaturan disimpan", "success");
    });
  }

  // ---------- Init ----------
  function init() {
    // Update date pill
    const datePills = $$(".datepill");
    datePills.forEach(el => { el.innerHTML = `▣ &nbsp; ${getTodayStr()}`; });

    updateClock();
    setInterval(updateClock, 1000);

    renderAttendanceTables();
    bindEvents();
    updateRole("admin");

    // Ensure first page active
    goToPage("dashboard");
  }

  // Load QR libraries dynamically
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  Promise.all([
    loadScript("https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"),
    loadScript("https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js")
  ]).then(() => {
    console.log("QR libraries loaded");
  }).catch(err => {
    console.warn("Some QR libraries failed to load:", err);
  }).finally(init);

})();
