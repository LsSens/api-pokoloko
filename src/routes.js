const express = require('express');
const router = express.Router();
const pool = require('./db');
const moment = require('moment');

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

router.get('/selecionado', (req, res) => {
    pool.query('SELECT * FROM selecionado', (error, results) => {
        if (error) {
            console.error('Erro ao obter fechamentos mensais:', error);
            return res.status(500).json({ error: error.message });
        }
        res.json(results);
    });
});

router.put('/selecionado', (req, res) => {
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

router.get('/fechamentos', (req, res) => {
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

router.put('/fechamentos/:id/dia/:day', (req, res) => {
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

router.post('/fechamentos', async (req, res) => {
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

router.put('/fechamentos/:id/meta', (req, res) => {
    const fechamentoId = req.params.id;
    const { meta_maxima } = req.body;

    pool.query(
        'UPDATE fechamento_mensal SET meta_maxima = ? WHERE id = ?',
        [meta_maxima, fechamentoId],
        (error, results) => {
            if (error) {
                return res.status(500).json({ error: error.message });
            }
            res.json({ message: 'Meta atualizada com sucesso' });
        }
    );
});

router.put('/fechamentos/:id/dias-trabalhados', (req, res) => {
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

module.exports = router;
