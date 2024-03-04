const express = require('express');
const spauth = require('node-sp-auth');
const fs = require('fs');
const Jimp = require('jimp');
const app = express();
const port = process.env.PORT || 3000; 
const fetch = require('node-fetch'); 
const nodemailer = require('nodemailer');
const sql = require('mssql');
const cors = require('cors');
const corsOptions = {
  origin: '*',
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions)); 

app.use(express.static(__dirname));
app.use(express.json());

app.get('/', function(req, res) {
  res.sendFile(__dirname + '/index.html');
});

const spAuthConfig = {
    username: process.env.username_SP,
    password:process.env.password_SP,
    online: true 
}

const dbConfig = {
  user: process.env.usernameGPReporting,
  password: process.env.passwordGPReporting,
  server: process.env.serverGPReporting,
  database: process.env.databaseGPReporting,
  options: {
    encrypt: true, 
    trustServerCertificate: true
  }
};

// Function to get employees from the database
async function getEmployees(term) {
  try {
    await sql.connect(dbConfig);
    const request = new sql.Request();
    request.input('term', sql.VarChar, `%${term}%`);

    const result = await request.query(`
    SELECT DISTINCT
    [name] = Rtrim(a.[FIRSTNAME]) + ' ' + Rtrim(a.Lastname),
    [work_email] = Rtrim(a.WORKADDRESS_EMAILADDRESS),
    [manager_email] = (
        SELECT TOP 1 RTRIM(e.userPrincipalName)
        FROM CF_T_ActiveDirectory_Temp e WITH(NOLOCK)
        WHERE e.[SAMAccountName] = Rtrim(c.[SAMAccountName])
    )
    FROM 
        [GPReporting].[dbo].[MR_Paylocity_Emp_DETAILS] a WITH(NOLOCK)
    INNER JOIN [GPReporting].[dbo].[MR_Paylocity_Emp_DETAILS] b WITH(NOLOCK) 
        ON a.DEPARTMENTPOSITION_SUPERVISOREMPLOYEEID = b.EMPLOYEEID
    LEFT JOIN [GPReporting].[dbo].[CF_T_ActiveDirectory_Temp] c WITH(NOLOCK) 
        ON b.WORKADDRESS_EMAILADDRESS = c.userPrincipalName
    LEFT JOIN [GPReporting].[dbo].[CF_T_ActiveDirectory_Temp] d WITH(NOLOCK) 
        ON a.WORKADDRESS_EMAILADDRESS = d.userPrincipalName
      WHERE a.FIRSTNAME LIKE @term OR a.LASTNAME LIKE @term
    `);

    return result.recordset;
  } catch (err) {
    console.error('SQL error', err);
    throw err;
  }
}



// Endpoint to search employees by name
app.get('/api/employees/search', async (req, res) => {
  const { term } = req.query;
  try {
    const employees = await getEmployees(term);
    res.json(employees);
  } catch (error) {
    console.error('Error searching employees:', error);
    res.status(500).send({ message: 'Error searching for employees', error: error.toString() });
  }
});

// Function to send emails
async function sendEmail({ from, to, cc, subject, buffer, replyTo }) {
  try {
      const transporter = nodemailer.createTransport({
          host: "smtp.office365.com",
          port: 587, 
          secure: false, 
          auth: {
              user: process.env.user_NoReply,
              pass: process.env.pass_NoReply
          },
          tls: {
            ciphers: 'SSLv3' 
          }
      });

      const mailOptions = {
        from: `E-card Service <${from}>`,
        replyTo: replyTo,
        to: to,
        cc: cc,
        subject: subject,
        attachments: [
          {
            filename: 'e-card.png',
            content: buffer, 
            contentType: 'image/png'
          }
        ], 
      };

    let info = await transporter.sendMail(mailOptions);
    console.log('Message sent: %s', info.messageId);

      return { success: true, message: 'E-card sent successfully' };
    } catch (error) {
      console.log('Error sending email:', error);
      return { success: false, message: 'Error sending email', error: error.message };
    }
}
  
//function to get image from sharepoint

async function getImageFromSharePoint(url) {
    const response = await spauth.getAuth(url, spAuthConfig);
    const headers = response.headers;
    headers['Accept'] = 'application/json;odata=verbose';
  
    const imageResponse = await fetch(url, { headers: headers });
    return imageResponse.buffer();
  }


//Overlay text on Image
  async function overlayTextOnImage(imagePath, text) {
      try {
        const imageBuffer = await getImageFromSharePoint(imagePath);
        const image = await Jimp.read(imageBuffer);

        // Specific card URL for which white font should be used
        const whiteFontCardUrl = "https://guardianfueltech.sharepoint.com/sites/GuardianFueling-Home/ECard%20Template/Happy_Birthday.png?csf=1&web=1&e=s8TXet&cid=2ed9b13f-56db-49a4-91bf-d4bd4d59d29b";

        // Determine font based on the card's image URL
        const fontPath = imagePath === whiteFontCardUrl ? Jimp.FONT_SANS_64_WHITE : Jimp.FONT_SANS_64_BLACK;

        const font = await Jimp.loadFont(fontPath);


        const padding = 40;
        const textBoxWidth = image.bitmap.width - (padding * 2);
        const additionalPadding = 30; // add more padding to shift the text to the right
        const textBoxX = padding + additionalPadding;
        
        let textHeight = Jimp.measureTextHeight(font, text, textBoxWidth);

        let textBoxY = (image.bitmap.height - textHeight) / 2;
        if (textBoxY < padding) {
            textBoxY = padding;
            textHeight = image.bitmap.height - (padding * 2);
        }
        image.print(
            font,
            textBoxX,
            textBoxY,
            {
                text: text,
                alignmentX: Jimp.HORIZONTAL_ALIGN_CENTER,
                alignmentY: Jimp.VERTICAL_ALIGN_TOP
            },
            textBoxWidth,
            textHeight 
        );
        
        return await image.getBufferAsync(Jimp.MIME_PNG);

      } catch (error) {
        console.error('Error:', error);
        throw error;
    }
}

//Image preview
app.post('/api/previewEcard', async (req, res) => {
    const { template, message } = req.body;
    try {
        const imageBuffer = await overlayTextOnImage(template, message);
        const image = `data:image/png;base64,${imageBuffer.toString('base64')}`;
        res.send(image);
    } catch (error) {
        console.error('Failed to create e-card preview:', error.message);
        res.status(500).send({ message: 'Error in creating e-card preview', error: error.message });
    }
});


// Endpoint to receive form data and process e-card
app.post('/api/sendEcard', async (req, res) => {
    const { from, to, cc, message, template } = req.body;
    console.log('Received request to send E-card:', req.body);

    try {
        const imageBuffer = await overlayTextOnImage(template, message);
        const emailResult = await sendEmail({
                      from: process.env.user_NoReply,
                      to: to,
                      cc: cc,
                      replyTo: from,
                      subject: "You've received an E-Card!",
                      buffer: imageBuffer

                    });
            if (emailResult.success) {
              res.status(200).send({ message: emailResult.message });
          } else {
              throw new Error(emailResult.message);
          }
      } catch (error) {
          console.error('Failed to send e-card:', error.message);
          res.status(500).send({ message: 'Error in creating or sending e-card', error: error.message });
    }
});


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
