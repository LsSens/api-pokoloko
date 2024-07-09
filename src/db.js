const mysql = require('mysql2');

const pool = mysql.createPool({
    host: "108.167.132.54",
    user: "luca0284_admpoko",
    password: "QJJ3FGvp)stQ",
    database: "luca0284_pokoloko",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool;