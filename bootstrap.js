// Crea el primer administrador al iniciar si no existe ninguno y se definieron ADMIN_EMAIL, ADMIN_NAME y ADMIN_PASSWORD.
// Útil en hostings gratuitos que no dan consola. Después de crear tu cuenta podés borrar ADMIN_PASSWORD del panel del hosting.
const { db } = require('./db');
const { hashPassword, v } = require('./lib');

async function bootstrapAdmin() {
  const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return;
  if (db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) return;
  try {
    const email = v.email(ADMIN_EMAIL), name = v.str(ADMIN_NAME || 'Administrador', 'name', { min: 2 });
    v.password(ADMIN_PASSWORD);
    db.prepare("INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,'admin')").run(name, email, await hashPassword(ADMIN_PASSWORD));
    console.log(`Administrador inicial creado: ${email}`);
  } catch (e) { console.error('No se pudo crear el administrador inicial:', e.message); }
}
module.exports = { bootstrapAdmin };
