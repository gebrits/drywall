var sendWelcomeEmail = function(req,res,workflow){
  req.app.utility.email(req, res, {
    from: req.app.get('email-from-name') +' <'+ req.app.get('email-from-address') +'>',
    to: req.body.email,
    subject: 'Your '+ req.app.get('project-name') +' Account',
    textPath: 'signup/email-text',
    htmlPath: 'signup/email-html',
    locals: {
      username: req.body.username,
      email: req.body.email,
      loginURL: 'http://'+ req.headers.host +'/login/',
      projectName: req.app.get('project-name')
    },
    success: function(message) {
      workflow.emit('logUserIn');
    },
    error: function(err) {
      console.log('Error Sending Welcome Email: '+ err);
      workflow.emit('logUserIn');
    }
  });
};

var subdomainAvailabilityCheck = function(req,res,workflow){
  var requestedSubdomain = req.body.subdomain;
  if((req.app.get("blacklisted-subdomains") || []).indexOf(requestedSubdomain) !== -1){
    workflow.outcome.errfor.subdomain = 'subdomain already taken';
    return workflow.emit('response');
  }
  req.app.db.models.User.findOne({ subdomain: req.body.subdomain }, function(err, user) {
    if (err) return workflow.emit('exception', err);
    if (user) {
      workflow.outcome.errfor.subdomain = 'subdomain already taken';
      return workflow.emit('response');
    }
    workflow.emit('createUser');
  });
};

var duplicateEmailCheck = function(req, res, workflow, subdomainUsed){
  req.app.db.models.User.findOne({ email: req.body.email }, function(err, user) {
    if (err) return workflow.emit('exception', err);

    if (user) {
      workflow.outcome.errfor.email = 'email already registered';
      return workflow.emit('response');
    }
    if(subdomainUsed){
      workflow.emit('subdomainAvailabilityCheck');
    }else{
      workflow.emit('createUser');
    }
  });
};

exports.init = function(req, res){
  //are we logged in?
  if (req.isAuthenticated()) { 
    res.redirect(req.user.defaultReturnUrl());
  }
  else {
    res.render('signup/index', {
      oauthMessage: '',
      oauthTwitter: !!req.app.get('twitter-oauth-key'),
      oauthGitHub: !!req.app.get('github-oauth-key'),
      oauthFacebook: !!req.app.get('facebook-oauth-key'),
      subdomainUsed: !!req.app.get("subdomain-per-user")
    });
  }
};

exports.signup = function(req, res){

  var workflow = new req.app.utility.Workflow(req, res),
      subdomainUsed = !!req.app.get("subdomain-per-user");

  workflow.on('validate', function() {
    if (!req.body.username) {
      workflow.outcome.errfor.username = 'required';
    }
    else if (!/^[a-zA-Z0-9\-\_]+$/.test(req.body.username)) {
      workflow.outcome.errfor.username = 'only use letters, numbers, \'-\', \'_\'';
    }

    if(subdomainUsed){
      if (!req.body.subdomain) {
        workflow.outcome.errfor.subdomain = 'required';
      }
      else if (!/^[a-zA-Z0-9\-\_]+$/.test(req.body.subdomain)) {
        workflow.outcome.errfor.subdomain = 'only use letters, numbers, \'-\', \'_\'';
      }
    }

    if (!req.body.email) {
      workflow.outcome.errfor.email = 'required';
    }
    else if (!/^[a-zA-Z0-9\-\_\.\+]+@[a-zA-Z0-9\-\_\.]+\.[a-zA-Z0-9\-\_]+$/.test(req.body.email)) {
      workflow.outcome.errfor.email = 'invalid email format';
    }
    if (!req.body.password) workflow.outcome.errfor.password = 'required';

    //return if we have errors already
    if (workflow.hasErrors()) return workflow.emit('response');

    workflow.emit('duplicateUsernameCheck');
  });
  

  workflow.on('duplicateUsernameCheck', function() {
    req.app.db.models.User.findOne({ username: req.body.username }, function(err, user) {
      if (err) return workflow.emit('exception', err);

      if (user) {
        workflow.outcome.errfor.username = 'username already taken';
        return workflow.emit('response');
      }

      workflow.emit('duplicateEmailCheck');
    });
  });

  workflow.on('duplicateEmailCheck', function() {
    duplicateEmailCheck(req, res, workflow, subdomainUsed);
  });

  workflow.on('subdomainAvailabilityCheck', function() {
    subdomainAvailabilityCheck(req,res,workflow);
  });

  workflow.on('createUser', function() {
    var fieldsToSet = {
      isActive: 'yes',
      username: req.body.username,
      email: req.body.email,
      subdomain: req.body.subdomain, //may be undefined when 
      password: req.app.db.models.User.encryptPassword(req.body.password),
      search: [
        req.body.username,
        req.body.email
      ]
    };
    req.app.db.models.User.create(fieldsToSet, function(err, user) {
      if (err) return workflow.emit('exception', err);

      workflow.user = user;
      workflow.emit('createAccount');
    });
  });

  workflow.on('createAccount', function() {
    var fieldsToSet = {
      'name.full': workflow.user.username,
      user: {
        id: workflow.user._id,
        name: workflow.user.username
      },
      search: [
        workflow.user.username
      ]
    };
    req.app.db.models.Account.create(fieldsToSet, function(err, account) {
      if (err) return workflow.emit('exception', err);

      //update user with account
      workflow.user.roles.account = account._id;
      workflow.user.save(function(err, user) {
        if (err) return workflow.emit('exception', err);
        workflow.emit('sendWelcomeEmail');
      });
    });
  });

  workflow.on('sendWelcomeEmail', function() {
    sendWelcomeEmail(req,res,workflow);
  });

  workflow.on('logUserIn', function() {
    req._passport.instance.authenticate('local', function(err, user, info) {
      if (err) return workflow.emit('exception', err);

      if (!user) {
        workflow.outcome.errors.push('Login failed. That is strange.');
        return workflow.emit('response');
      }
      else {
        req.login(user, function(err) {
          if (err) return workflow.emit('exception', err);

          workflow.outcome.defaultReturnUrl = user.defaultReturnUrl();
          workflow.emit('response');
        });
      }
    })(req, res);
  });

  workflow.emit('validate');
};

exports.signupTwitter = function(req, res, next) {
  var subdomainUsed = !!req.app.get("subdomain-per-user");

  req._passport.instance.authenticate('twitter', function(err, user, info) {
    if (!info || !info.profile) return res.redirect('/signup/');

    req.app.db.models.User.findOne({ 'twitter.id': info.profile.id }, function(err, user) {
      if (err) return next(err);

      if (!user) {
        req.session.socialProfile = info.profile;
        res.render('signup/social', { email: '', subdomainUsed: subdomainUsed});
      }
      else {
        res.render('signup/index', {
          oauthMessage: 'We found a user linked to your Twitter account.',
          oauthTwitter: !!req.app.get('twitter-oauth-key'),
          oauthGitHub: !!req.app.get('github-oauth-key'),
          oauthFacebook: !!req.app.get('facebook-oauth-key'),
          subdomainUsed: subdomainUsed
        });
      }
    });
  })(req, res, next);
};



exports.signupGitHub = function(req, res, next) {

  var subdomainUsed = !!req.app.get("subdomain-per-user");

  req._passport.instance.authenticate('github', function(err, user, info) {
    if (!info || !info.profile) return res.redirect('/signup/');

    req.app.db.models.User.findOne({ 'github.id': info.profile.id }, function(err, user) {
      if (err) return next(err);

      if (!user) {
        req.session.socialProfile = info.profile;
        res.render('signup/social', { email: info.profile.emails[0].value || '', subdomainUsed: subdomainUsed });
      }
      else {
        res.render('signup/index', {
          oauthMessage: 'We found a user linked to your GitHub account.',
          oauthTwitter: !!req.app.get('twitter-oauth-key'),
          oauthGitHub: !!req.app.get('github-oauth-key'),
          oauthFacebook: !!req.app.get('facebook-oauth-key'),
          subdomainUsed: subdomainUsed
        });
      }
    });
  })(req, res, next);
};



exports.signupFacebook = function(req, res, next) {

  var subdomainUsed = !!req.app.get("subdomain-per-user");

  req._passport.instance.authenticate('facebook', { callbackURL: '/signup/facebook/callback/' }, function(err, user, info) {
    if (!info || !info.profile) return res.redirect('/signup/');

    req.app.db.models.User.findOne({ 'facebook.id': info.profile.id }, function(err, user) {
      if (err) return next(err);

      if (!user) {
        req.session.socialProfile = info.profile;
        res.render('signup/social', { email: info.profile.emails[0].value || '', subdomainUsed: subdomainUsed });
      }
      else {
        res.render('signup/index', {
          oauthMessage: 'We found a user linked to your Facebook account.',
          oauthTwitter: !!req.app.get('twitter-oauth-key'),
          oauthGitHub: !!req.app.get('github-oauth-key'),
          oauthFacebook: !!req.app.get('facebook-oauth-key'),
          subdomainUsed: subdomainUsed
        });
      }
    });
  })(req, res, next);
};



exports.signupSocial = function(req, res){
  var workflow = new req.app.utility.Workflow(req, res),
      subdomainUsed = !!req.app.get("subdomain-per-user");

  workflow.on('validate', function() {
    if (!req.body.email) {
      workflow.outcome.errfor.email = 'required';
    }
    else if (!/^[a-zA-Z0-9\-\_\.\+]+@[a-zA-Z0-9\-\_\.]+\.[a-zA-Z0-9\-\_]+$/.test(req.body.email)) {
      workflow.outcome.errfor.email = 'invalid email format';
    }

    if(subdomainUsed){
      if (!req.body.subdomain) {
        workflow.outcome.errfor.subdomain = 'required';
      }
      else if (!/^[a-zA-Z0-9\-\_]+$/.test(req.body.subdomain)) {
        workflow.outcome.errfor.subdomain = 'only use letters, numbers, \'-\', \'_\'';
      }
    }

    //return if we have errors already
    if (workflow.hasErrors()) return workflow.emit('response');

    workflow.emit('duplicateUsernameCheck');
  });

  workflow.on('duplicateUsernameCheck', function() {
    workflow.username = req.session.socialProfile.username;
    if (!/^[a-zA-Z0-9\-\_]+$/.test(workflow.username)) {
      workflow.username = workflow.username.replace(/[^a-zA-Z0-9\-\_]/g, '');
    }

    req.app.db.models.User.findOne({ username: workflow.username }, function(err, user) {
      if (err) return workflow.emit('exception', err);

      if (user) {
        workflow.username = workflow.username + req.session.socialProfile.id;
      }
      else {
        workflow.username = workflow.username;
      }

      workflow.emit('duplicateEmailCheck');
    });
  });

  workflow.on('duplicateEmailCheck', function() {
    duplicateEmailCheck(req, res, workflow, subdomainUsed);
  });

  workflow.on('subdomainAvailabilityCheck', function() {
    subdomainAvailabilityCheck(req,res,workflow);
  });

  workflow.on('createUser', function() {
    var fieldsToSet = {
      isActive: 'yes',
      username: workflow.username,
      email: req.body.email,
      subdomain: req.body.subdomain,
      search: [
        workflow.username,
        req.body.email
      ]
    };
    fieldsToSet[req.session.socialProfile.provider] = req.session.socialProfile._json;

    req.app.db.models.User.create(fieldsToSet, function(err, user) {
      if (err) return workflow.emit('exception', err);

      workflow.user = user;
      workflow.emit('createAccount');
    });
  });

  workflow.on('createAccount', function() {
    var nameParts = req.session.socialProfile.displayName.split(' ');
    var fieldsToSet = {
      'name.first': nameParts[0],
      'name.last': nameParts[1] || '',
      'name.full': req.session.socialProfile.displayName,
      user: {
        id: workflow.user._id,
        name: workflow.user.username
      },
      search: [
        nameParts[0],
        nameParts[1] || ''
      ]
    };
    req.app.db.models.Account.create(fieldsToSet, function(err, account) {
      if (err) return workflow.emit('exception', err);

      //update user with account
      workflow.user.roles.account = account._id;
      workflow.user.save(function(err, user) {
        if (err) return workflow.emit('exception', err);
        workflow.emit('sendWelcomeEmail');
      });
    });
  });

  workflow.on('sendWelcomeEmail', function() {
    sendWelcomeEmail(req,res,workflow);
  });

  workflow.on('logUserIn', function() {
    req.login(workflow.user, function(err) {
      if (err) return workflow.emit('exception', err);

      delete req.session.socialProfile;
      workflow.outcome.defaultReturnUrl = workflow.user.defaultReturnUrl();
      workflow.emit('response');
    });
  });

  workflow.emit('validate');
};