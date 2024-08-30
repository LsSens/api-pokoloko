const express = require('express');
const router = express.Router();
const pool = require('./db');
const moment = require('moment');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const SECRET = 'pokolokotestsecret'
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const createTableIfNotExists = async (tableName, createTableSQL) => {
    try {
        const [rows] = await pool.promise().query(`SHOW TABLES LIKE '${tableName}'`);
        if (rows.length === 0) {
            await pool.promise().query(createTableSQL);
            console.log(`Tabela ${tableName} criada com sucesso.`);
        } else {
            console.log(`Tabela ${tableName} já existe.`);
        }
    } catch (err) {
        console.error(`Erro ao criar/verificar tabela ${tableName}:`, err);
    }
};

const createTables = async () => {
    const createTableSelecionado = `
        CREATE TABLE IF NOT EXISTS selecionado (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ano INT NOT NULL,
            mes INT NOT NULL,
            UNIQUE KEY unique_ano_mes (ano, mes)
        )
    `;
    const createTableFechamentoMensal = `
        CREATE TABLE IF NOT EXISTS fechamento_mensal (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ano INT NOT NULL,
            mes INT NOT NULL,
            dias_trabalhados INT DEFAULT 0,
            meta_maxima DECIMAL(10, 2) DEFAULT 0.00,
            meta_minima DECIMAL(10, 2) DEFAULT 0.00,
            valores_diarios JSON NOT NULL,
            soma_valores DECIMAL(10, 2) DEFAULT 0.00
        )
    `;

    await createTableIfNotExists('selecionado', createTableSelecionado);
    await createTableIfNotExists('fechamento_mensal', createTableFechamentoMensal);
};

const initializeDatabase = async () => {
    await createTables();

    const today = moment().utcOffset(-3);
    const year = today.year();
    const month = today.month() + 1;

    const sqlCount = 'SELECT COUNT(*) as count FROM selecionado';
    const [result] = await pool.promise().query(sqlCount);

    if (result[0].count === 0) {
        const sqlInsert = 'INSERT INTO selecionado (ano, mes) VALUES (?, ?)';
        await pool.promise().query(sqlInsert, [year, month]);
        console.log('Tabela selecionado preenchida com o mês e ano atuais.');
    }

    const sqlCheck = `SELECT * FROM fechamento_mensal WHERE ano = ? AND mes = ?`;
    pool.query(sqlCheck, [year, month], (err, results) => {
        if (err) {
            console.error('Erro ao verificar dados existentes:', err);
            throw err;
        }

        if (results.length === 0) {
            const daysInMonth = today.daysInMonth();
            const valoresDiarios = Array.from({ length: daysInMonth }, (_, index) => ({
                day: index + 1,
                value: 0
            }));

            const sqlInsert = `
                INSERT INTO fechamento_mensal (ano, mes, dias_trabalhados, meta_maxima, meta_minima, valores_diarios, soma_valores)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;
            const values = [year, month, 0, 0, 0, JSON.stringify(valoresDiarios), 0];

            pool.query(sqlInsert, values, (err, result) => {
                if (err) {
                    console.error('Erro ao inserir novo registro:', err);
                    throw err;
                }
                console.log('Novo registro inserido com sucesso:', result);
            });
        } else {
            console.log('Já existe um registro para o ano e mês atual.');
        }
    });
};

initializeDatabase().catch(err => {
    console.error('Erro ao inicializar banco de dados:', err);
    process.exit(1);
});

function verifyJWT(req, res, next) {
    const token = req.headers['x-access-token'];
    jwt.verify(token, SECRET, (err, decoded) => {
        if (err) return res.status(401).end();

        req.userId = decoded.userId
        next();
    });
}

function somarValores(valores) {
    let soma = 0;
    for (let i = 0; i < valores.length; i++) {
        soma += parseFloat(valores[i].value);
    }
    return soma;
}

function updateTotal(fechamentoId) {
    pool.query(
        'SELECT valores_diarios FROM fechamento_mensal WHERE id = ?',
        [fechamentoId],
        (error, results) => {
            if (error) {
                console.error('Erro ao obter valores diários:', error);
                return;
            }

            if (results.length === 0) {
                console.error('Fechamento mensal não encontrado');
                return;
            }

            const valoresDiarios = results[0].valores_diarios;
            const total = somarValores(valoresDiarios);

            pool.query(
                'UPDATE fechamento_mensal SET soma_valores = ? WHERE id = ?',
                [total, fechamentoId],
                (error, results) => {
                    if (error) {
                        console.error('Erro ao atualizar soma dos valores:', error);
                    }
                }
            );
        }
    );
}

router.get('/protected', verifyJWT, (req, res) => {
    res.status(200).end();
    return res.json({ auth: true, token,
        user: {
            id: user.id,
            email: user.email,
            nome: user.user
        }
    });
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const [rows, fields] = await pool.promise().query('SELECT * FROM users WHERE email = ?', [email]);
    
        if (rows.length === 0) {
            return res.status(401).end();
        }
        const user = rows[0];
    
        const match = await bcrypt.compare(password, user.password);
        if (match) {
            const token = jwt.sign({userId: user.id}, SECRET, { expiresIn: 300 });
            return res.json({ auth: true, token,
                user: {
                    id: user.id,
                    email: user.email,
                    nome: user.user
                }
            });
        } else {
            return res.status(401).end();
        }
    } catch (error) {
        return res.status(500).end();
    }
});

router.get('/me', verifyJWT, async (req, res) => {
    try {
        const userId = req.userId;
        
        const [rows] = await pool.promise().query('SELECT id, email, user FROM users WHERE id = ?', [userId]);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado' });
        }
        
        const user = rows[0];
        res.json({
            id: user.id,
            email: user.email,
            nome: user.user
        });
    } catch (error) {
        console.error('Erro ao obter dados do usuário:', error);
        res.status(500).json({ error: error.message });
    }
});

router.get('/selecionado', verifyJWT, (req, res) => {
    pool.query('SELECT * FROM selecionado', (error, results) => {
        if (error) {
            console.error('Erro ao obter fechamentos mensais:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json(results);
    });
});

router.put('/selecionado', verifyJWT, (req, res) => {
    const { ano, mes } = req.body;

    if (!ano || !mes) {
        return res.status(400).json({ error: 'Ano e mês são obrigatórios' });
    }

    pool.query('UPDATE selecionado SET ano = ?, mes = ?', [ano, mes], (error, results) => {
        if (error) {
            console.error('Erro ao atualizar fechamentos mensais:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json({ message: 'Dados atualizados com sucesso' });
    });
});

router.get('/fechamentos', verifyJWT, (req, res) => {
    pool.query('SELECT * FROM fechamento_mensal', (error, results) => {
        if (error) {
            console.error('Erro ao obter fechamentos mensais:', error);
            return res.status(500).json({ error: error.message });
        }
        results.forEach(row => {
            updateTotal(row.id);
        });
        res.json(results);
    });
});

router.put('/fechamentos/:id/dia/:day', verifyJWT, (req, res) => {
    const fechamentoId = req.params.id;
    const day = req.params.day;
    const { value } = req.body;

    pool.query(
        'SELECT valores_diarios FROM fechamento_mensal WHERE id = ?',
        [fechamentoId],
        (error, results) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }

            if (results.length === 0) {
                return res.status(404).json({ error: 'Fechamento mensal não encontrado' });
            }

            const valoresDiarios = results[0].valores_diarios;

            const dayIndex = day - 1;
            if (valoresDiarios[dayIndex]) {
                valoresDiarios[dayIndex].value = value;
            } else {
                valoresDiarios[dayIndex] = { day, value };
            }

            pool.query(
                'UPDATE fechamento_mensal SET valores_diarios = ? WHERE id = ?',
                [JSON.stringify(valoresDiarios), fechamentoId],
                (error, results) => {
                    if (error) {
                        return res.status(500).json({ error: error.message });
                    }
                    res.json({ message: 'Valor adicionado com sucesso' });
                }
            );
        }
    );
});

router.post('/fechamentos', verifyJWT, async (req, res) => {
    const { years } = req.body;
    
    const year = Object.keys(years)[0];
    const month = Object.keys(years[year].months)[0];
    const days_worked = years[year].months[month].days_worked;
    const max_goal = years[year].months[month].max_goal;
    const min_goal = years[year].months[month].min_goal;
    const day_values = years[year].months[month].day_values;

    const valoresDiarios = Array.from({ length: 30 }, (_, index) => {
        const dayData = day_values.find(day => day.day === index + 1);
        return { day: index + 1, value: dayData ? dayData.value : 0 };
    });

    const sqlInsert = `
        INSERT INTO fechamento_mensal (ano, mes, dias_trabalhados, meta_maxima, meta_minima, valores_diarios, soma_valores)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
        year,
        month,
        days_worked,
        max_goal,
        min_goal,
        JSON.stringify(valoresDiarios),
        somarValores(valoresDiarios)
    ];

    try {
        await pool.promise().query(sqlInsert, values);
        res.json({ message: 'Registro de fechamento mensal criado com sucesso' });
    } catch (error) {
        console.error('Erro ao inserir novo registro:', error);
        res.status(500).json({ error: error.message });
    }
});

router.put('/fechamentos/:id/meta', verifyJWT, (req, res) => {
    const fechamentoId = req.params.id;
    const { meta_maxima, meta_minima } = req.body;

    pool.query(
        'UPDATE fechamento_mensal SET meta_maxima = ?, meta_minima = ? WHERE id = ?',
        [meta_maxima, meta_minima, fechamentoId],
        (error, results) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }
            res.json({ message: 'Meta atualizada com sucesso' });
        }
    );
});

router.put('/fechamentos/:id/dias-trabalhados', verifyJWT, (req, res) => {
    const fechamentoId = req.params.id;
    const { dias_trabalhados } = req.body;

    pool.query(
        'UPDATE fechamento_mensal SET dias_trabalhados = ? WHERE id = ?',
        [dias_trabalhados, fechamentoId],
        (error, results) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }
            res.json({ message: 'Dias trabalhados atualizados com sucesso' });
        }
    );
});

const transporter = nodemailer.createTransport({
    host: 'smtp.titan.hostgator.com.br', // Servidor SMTP do HostGator
    port: 587, // Porta para TLS
    secure: false, // Use true para SSL, false para TLS
    auth: {
        user: 'admin@lucassens.com.br', // Seu e-mail
        pass: 'pF(3}&=yP<eK^:7' // Sua senha de e-mail
    }
});

router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'E-mail é obrigatório' });
    }

    try {
        const [rows] = await pool.promise().query('SELECT id FROM users WHERE email = ?', [email]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'E-mail não encontrado' });
        }

        const userId = rows[0].id;
        const code = crypto.randomInt(100000, 999999); // Gera um código numérico de 6 dígitos
        const expiration = new Date(Date.now() + 3600000); // Código expira em 1 hora

        // Armazena o código e a expiração no banco de dados
        await pool.promise().query(
            'INSERT INTO password_reset_codes (user_id, code, expires_at) VALUES (?, ?, ?)',
            [userId, code, expiration]
        );

        // Envia o e-mail com o código de verificação
        const mailOptions = {
            from: 'admin@lucassens.com.br',
            to: email,
            subject: 'Código de Redefinição de Senha',
            text: `Você solicitou a redefinição da sua senha. Use o código abaixo para redefinir sua senha:\n\nCódigo: ${code}`
        };

        await transporter.sendMail(mailOptions);

        res.json({ message: 'Código de redefinição de senha enviado com sucesso' });

    } catch (error) {
        console.error('Erro ao processar a solicitação de redefinição de senha:', error);
        res.status(500).json({ error: 'Erro ao processar a solicitação' });
    }
});

router.post('/reset-password', async (req, res) => {
    const { email, code, newPassword } = req.body;

    if (!email || !code || !newPassword) {
        return res.status(400).json({ error: 'E-mail, código e nova senha são obrigatórios' });
    }

    try {
        // Verifica o código e a expiração
        const [rows] = await pool.promise().query(
            'SELECT user_id FROM password_reset_codes WHERE code = ? AND expires_at > NOW()',
            [code]
        );

        if (rows.length === 0) {
            return res.status(400).json({ error: 'Código inválido ou expirado' });
        }

        const userId = rows[0].user_id;

        // Atualiza a senha do usuário
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.promise().query(
            'UPDATE users SET password = ? WHERE id = ?',
            [hashedPassword, userId]
        );

        // Remove o código após a redefinição
        await pool.promise().query('DELETE FROM password_reset_codes WHERE code = ?', [code]);

        res.json({ message: 'Senha redefinida com sucesso' });

    } catch (error) {
        console.error('Erro ao redefinir a senha:', error);
        res.status(500).json({ error: 'Erro ao redefinir a senha' });
    }
});

module.exports = router;
