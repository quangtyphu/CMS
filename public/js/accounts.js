console.log("✅ accounts.js đã load");

async function loadAccounts() {
  const res = await fetch('/api/accounts');
  const data = await res.json();
  const tbody = document.querySelector("#accountTable tbody");
  tbody.innerHTML = "";
  data.forEach(acc => {
    const row = `<tr>
      <td>${acc.game}</td>
      <td>${acc.username}</td>
      <td>••••••</td>
      <td>${acc.phone}</td>
      <td>****</td>
      <td>${acc.bank}</td>
      <td>${acc.accountNumber}</td>
      <td>${acc.accountHolder}</td>
    </tr>`;
    tbody.innerHTML += row;
  });
}

document.getElementById("accountForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const newAcc = {
    game: document.getElementById("game").value,
    username: document.getElementById("username").value,
    loginPass: document.getElementById("loginPass").value,
    phone: document.getElementById("phone").value,
    withdrawPass: document.getElementById("withdrawPass").value,
    bank: document.getElementById("bank").value,
    accountNumber: document.getElementById("accountNumber").value,
    accountHolder: document.getElementById("accountHolder").value
  };

  await fetch('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newAcc)
  });

  document.getElementById("accountForm").reset();
  loadAccounts();
});

// Tải dữ liệu ban đầu
loadAccounts();
